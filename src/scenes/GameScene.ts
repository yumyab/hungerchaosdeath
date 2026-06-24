import Phaser from "phaser";
import {
  Creature,
  Death,
  Hunter,
  Foliage,
  Home,
  CreatureGenes,
} from "./entities";
import GameManager from "./GameManager";
import { getRandomSpawnPoint, getPathGrid } from "./utils";
import { DEBUG, dlog } from "./debug";

// Minimal shape of the camera's WebGL post-FX controller (typed loosely so we
// don't depend on the exact Phaser FX types, which vary by build).
type PostFx = {
  clear: () => unknown;
  addVignette: (x: number, y: number, radius: number, strength: number) => unknown;
  addBloom: (
    color: number,
    offsetX: number,
    offsetY: number,
    blurStrength: number,
    strength: number,
    steps: number
  ) => unknown;
  addGlow: (
    color: number,
    outerStrength: number,
    innerStrength: number,
    knockout: boolean,
    quality: number,
    distance: number
  ) => unknown;
  addColorMatrix: () => {
    saturate: (value: number, multiply?: boolean) => unknown;
    brightness: (value: number, multiply?: boolean) => unknown;
  };
};

// Grass (background) colours selectable in the options panel. "murky" is the
// current old-world green; "classic" is the original brighter sea-green.
export const GRASS_COLORS: Record<string, string> = {
  murky: "#243524",
  classic: "#2e8b57",
};

export default class GameScene extends Phaser.Scene {
  public creatures: Phaser.GameObjects.Group;
  public hunters: Phaser.GameObjects.Group;
  public foliage: Phaser.GameObjects.Group;
  public homes: Phaser.GameObjects.Group;
  private player: Phaser.GameObjects.Sprite;
  private playerX = 0; // skull base position (without the floating bob)
  private playerY = 0;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyW?: Phaser.Input.Keyboard.Key;
  private keyA?: Phaser.Input.Keyboard.Key;
  private keyS?: Phaser.Input.Keyboard.Key;
  private keyD?: Phaser.Input.Keyboard.Key;
  private lastTrailAt = 0; // throttle for the skull's foliage trail
  private readonly skullFearRadius = 150; // path obstacle radius for the skull
  private deaths: Phaser.GameObjects.Group;
  private bloodEmitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparkEmitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private fogMist?: Phaser.GameObjects.Particles.ParticleEmitter;
  private fogRt?: Phaser.GameObjects.RenderTexture;
  private fogCloud?: Phaser.GameObjects.RenderTexture;
  private fogCloudW = 0;
  private fogCloudH = 0;
  private fogBrush?: Phaser.GameObjects.Image; // soft brush to erase fog holes
  // Fertilised soil left by creature deaths: each sprouts plants outward in
  // rings over a few ticks, then is spent. (x,y) = death site.
  private fertilisers: {
    x: number;
    y: number;
    next: number;
    ring: number;
    left: number;
  }[] = [];
  private lastFogUpdate = 0;
  // Fog style: "off" | "mist" | "cloud". Selectable in the options panel.
  private fogStyle = "mist";
  private level = 1; // the current day; days are endless now
  private bestDay = 1; // highest day reached, persisted as the high score
  // Cumulative stats logged locally across all runs (shown in the stats panel).
  private stats = { runs: 0, survived: 0, eaten: 0, planted: 0 };
  private survivorGenes: CreatureGenes[] = []; // genes of this day's survivors
  private survivedThisLevel = 0; // reached a home this level
  private eatenThisLevel = 0; // caught by a hunter this level
  private totalSurvived = 0;
  private totalEaten = 0;
  private gameManager: GameManager;
  private pathGrid: number[][] = [];
  private longPressTimer: Phaser.Time.TimerEvent | null = null;
  private foliageStreamTimer: Phaser.Time.TimerEvent | null = null;
  private lastAutoSpawn = 0; // time accumulator for ongoing plant spawning
  private lastCountUpdate = 0; // throttle for the live creature/hunter HUD counts
  private music: Phaser.Sound.BaseSound;
  private isMusicPlaying: boolean = false;
  private roundEnding = false;
  // The eerie mood, broken into independent effects toggled in the options
  // panel. All default on; persisted per-effect in localStorage.
  private fx = { vignette: true, grade: true };
  // Grass (background) colour key into GRASS_COLORS. Selectable in options.
  private grassKey = "murky";
  private masterVolume = 1; // 0..1, cycled by the volume button
  private lastWailAt = 0; // throttles death wails so they don't stack into a roar
  private endText?: Phaser.GameObjects.Text;
  private endSubText?: Phaser.GameObjects.Text;
  private lastGridUpdate = 0;
  private gridUpdateInterval = 200;
  private titleFlashTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super("GameScene");
    this.gameManager = GameManager.getInstance();
  }

  public create(): void {
    // World dimensions come from the game config, so the map can be resized in
    // one place (main.ts) without re-hardcoding positions here.
    const W = this.scale.width;
    const H = this.scale.height;

    // Set up the game world
    this.cameras.main.setBounds(0, 0, W, H);
    this.physics.world.setBounds(0, 0, W, H);

    // Create groups
    this.creatures = this.add.group();
    this.hunters = this.add.group();
    this.foliage = this.add.group();
    this.homes = this.add.group();
    this.deaths = this.add.group();

    // Grass colour (applied for real in applyFx, after loadFx reads the pref).
    this.cameras.main.setBackgroundColor(GRASS_COLORS[this.grassKey]);

    this.setupFx();

    // Reuse the music started in StartScene so the audio toggle works in-game.
    this.music =
      this.sound.get("music") ?? this.sound.add("music", { loop: true });
    this.isMusicPlaying = this.music.isPlaying;

    // Master volume (scales music + effects), persisted across sessions.
    try {
      const v = parseFloat(localStorage.getItem("chd-vol") ?? "1");
      if (!Number.isNaN(v)) {
        this.masterVolume = Phaser.Math.Clamp(v, 0, 1);
      }
    } catch (e) {
      /* ignore */
    }
    this.sound.volume = this.masterVolume;

    // Best day reached so far (the high score), persisted across runs.
    try {
      const b = parseInt(localStorage.getItem("chd-best") ?? "1", 10);
      if (!Number.isNaN(b)) {
        this.bestDay = Math.max(1, b);
      }
    } catch (e) {
      /* ignore */
    }

    // Cumulative local stats, persisted across runs.
    this.loadStats();

    // The HUD and all controls live in the DOM top bar (index.html).
    this.bindDomUi();

    // The skull: floats, flushes red on each kill, and the player drives it with
    // WASD / arrow keys. It's a large obstacle everything paths around, and it
    // leaves a slow trail of foliage. Planting is still done by clicking.
    this.playerX = W / 2;
    this.playerY = H / 2;
    this.player = this.add.sprite(this.playerX, this.playerY, "player");
    this.player.setScale(this.gameManager.getPlayerSize() / this.player.width);
    this.player.setDepth(850);
    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.keyW = this.input.keyboard.addKey("W");
      this.keyA = this.input.keyboard.addKey("A");
      this.keyS = this.input.keyboard.addKey("S");
      this.keyD = this.input.keyboard.addKey("D");
    }

    // Eating is detected by proximity in Creature.update (most plant textures
    // scale to a sub-pixel physics body, so an overlap barely ever fires).

    // Reaching a home is detected by proximity each frame (see
    // checkHomeArrivals). Homes are not physics bodies, so an arcade overlap
    // would never fire.

    // Hunters kill the nearest creature on contact. Registered once for the
    // whole group (not per hunter) so a single kill is processed exactly once.
    this.physics.add.overlap(
      this.hunters,
      this.creatures,
      this.handleHunterCreatureOverlap,
      undefined,
      this
    );

    // (Breeding happens when a creature eats its fill — see Creature.reproduce.
    // There's no creature-vs-creature overlap, which would be an O(n^2) physics
    // check that tanks the framerate once the flock is large.)

    // Handle foliage spawning on click
    this.input.on("pointerdown", this.spawnFoliageAtPointer, this);
    this.input.on(
      "pointerdown",
      (pointer: Phaser.Input.Pointer) => {
        this.handleLongPress(pointer);
      },
      this
    );

    this.input.on(
      "pointerup",
      () => {
        if (this.longPressTimer) {
          this.longPressTimer.remove();
          this.longPressTimer = null;
        }
        if (this.foliageStreamTimer) {
          this.foliageStreamTimer.destroy();
          this.foliageStreamTimer = null;
        }
      },
      this
    );
    // Initialize the path grid
    this.pathGrid = getPathGrid(this, this.gameManager.getGridSize());

    // Start the game
    this.startGame();

    if (DEBUG) {
      (window as unknown as { __chdState?: () => unknown }).__chdState = () =>
        this.debugState();
      // Force a level resolution on demand: __chdEnd("Hunger") wins (>=1
      // survivor), __chdEnd("Death") loses (0 survivors).
      (window as unknown as { __chdEnd?: (r: string) => void }).__chdEnd = (
        r: string
      ) => {
        this.survivedThisLevel = r === "Death" ? 0 : Math.max(1, this.survivedThisLevel);
        this.resolveLevel();
      };
      // Do any homes actually have a physics body? (overlaps need one.)
      const homesWithBody = (this.homes.getChildren() as Phaser.GameObjects.GameObject[])
        .filter((h) => (h as { body?: unknown }).body).length;
      dlog("ready", {
        creatures: this.creatures.countActive(),
        homes: this.homes.getLength(),
        homesWithBody,
      });
    }
  }

  // Live snapshot for the debug probe. `creaturesOnHome` counts creatures
  // physically sitting on a home tile, so we can tell whether reaching a home
  // fails to register (overlap never fires) versus creatures never arriving.
  private debugState() {
    let creaturesOnHome = 0;
    let eating = 0;
    let frozen = 0; // not eating, barely moving — i.e. stuck
    let stuckNearFood = 0; // frozen and right next to a plant it should eat
    let eatenTotal = 0; // sum of plants every living creature has eaten so far
    const homes = this.homes.getChildren() as Home[];
    const foliage = this.foliage.getChildren() as Foliage[];
    (this.creatures.getChildren() as Creature[]).forEach((c) => {
      if (!c.active) return;
      for (const h of homes) {
        if (Phaser.Math.Distance.Between(c.x, c.y, h.x, h.y) <= 24) {
          creaturesOnHome++;
          break;
        }
      }
      eatenTotal += (c as unknown as { foliageEaten: number }).foliageEaten ?? 0;
      if (c.isEating) {
        eating++;
        return;
      }
      const body = c.body as Phaser.Physics.Arcade.Body;
      const speed = body ? body.velocity.length() : 0;
      if (speed < 5) {
        frozen++;
      }
      // Near a plant but not eating it = circling/stuck on food.
      if (
        foliage.some(
          (f) =>
            f.active && Phaser.Math.Distance.Between(c.x, c.y, f.x, f.y) <= 35
        )
      ) {
        stuckNearFood++;
      }
    });
    return {
      t: Math.round(this.time.now),
      level: this.level,
      creatures: this.creatures.countActive(),
      hunters: this.hunters.countActive(),
      foliage: this.foliage.countActive(),
      survived: this.survivedThisLevel,
      eaten: this.eatenThisLevel,
      roundEnding: this.roundEnding,
      creaturesOnHome,
      eating,
      frozen,
      stuckNearFood,
      eatenTotal,
    };
  }

  public update(): void {
    this.updatePlayer();
    this.updatePathGrid();
    this.updateCreatures();
    this.updateHunters();
    this.maybeAutoSpawn();
    this.updateFertilisers();
    this.checkHomeArrivals();
    this.checkGameOverConditions();
    this.updateCounts();
    this.updateFog();
  }

  // Live creature/hunter counts in the HUD, refreshed a few times a second.
  private updateCounts(): void {
    if (this.time.now - this.lastCountUpdate < 250) {
      return;
    }
    this.lastCountUpdate = this.time.now;
    const cr = document.getElementById("hud-creatures");
    const hu = document.getElementById("hud-hunters");
    const pl = document.getElementById("hud-plants");
    if (cr) {
      cr.textContent = `Creatures ${this.creatures.countActive()}`;
    }
    if (hu) {
      hu.textContent = `Hunters ${this.hunters.countActive()}`;
    }
    if (pl) {
      pl.textContent = `Plants ${this.foliage.countActive()}`;
    }
    // Flush the cumulative stats here too (cheap, already throttled to 4x/sec).
    this.saveStats();
  }

  // Drive the skull with WASD / arrows, keep it floating, and trail foliage.
  private updatePlayer(): void {
    const p = this.player;
    if (!p) {
      return;
    }
    const dt = Math.min(this.game.loop.delta / 1000, 0.05);
    const down = (k?: Phaser.Input.Keyboard.Key) => !!k && k.isDown;
    let dx = 0;
    let dy = 0;
    if (down(this.cursors?.left) || down(this.keyA)) dx -= 1;
    if (down(this.cursors?.right) || down(this.keyD)) dx += 1;
    if (down(this.cursors?.up) || down(this.keyW)) dy -= 1;
    if (down(this.cursors?.down) || down(this.keyS)) dy += 1;

    let moved = false;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      const speed = 240; // px/sec
      this.playerX = Phaser.Math.Clamp(
        this.playerX + (dx / len) * speed * dt,
        20,
        this.scale.width - 20
      );
      this.playerY = Phaser.Math.Clamp(
        this.playerY + (dy / len) * speed * dt,
        20,
        this.scale.height - 20
      );
      moved = true;
    }

    // Apply the base position plus a gentle floating bob.
    p.x = this.playerX;
    p.y = this.playerY + Math.sin(this.time.now / 600) * 6;

    if (moved) {
      this.maybeTrailFoliage();
    }
  }

  // The skull's obstacle footprint, read by getPathGrid (and only while fog of
  // movement matters). Null if the skull doesn't exist yet.
  public skullScare(): { x: number; y: number; r: number } | null {
    if (!this.player) {
      return null;
    }
    return { x: this.playerX, y: this.playerY, r: this.skullFearRadius };
  }

  // Drop an occasional plant in the skull's wake as it moves.
  private maybeTrailFoliage(): void {
    if (this.time.now - this.lastTrailAt < 140) {
      return;
    }
    this.lastTrailAt = this.time.now;
    if (this.foliage.countActive() >= this.gameManager.getMaxFoliage()) {
      return;
    }
    this.plantOne(
      this.playerX + Phaser.Math.Between(-18, 18),
      this.playerY + Phaser.Math.Between(-18, 18)
    );
  }

  private updatePathGrid(): void {
    // Rebuilding the grid scans every foliage against every cell, so do it a
    // few times a second instead of every frame. Pathing stays responsive and
    // the cost no longer climbs with the frame rate as foliage spreads.
    const now = this.time.now;
    if (now - this.lastGridUpdate < this.gridUpdateInterval) {
      return;
    }
    this.lastGridUpdate = now;
    try {
      this.pathGrid = getPathGrid(this, this.gameManager.getGridSize());
    } catch (error) {
      console.error("Error updating path grid:", error);
    }
  }

  private updateCreatures(): void {
    this.creatures.children.iterate(
      (creature: Phaser.GameObjects.GameObject) => {
        if (creature instanceof Creature) {
          creature.update(this);
        }
        return true;
      }
    );
  }

  private updateHunters(): void {
    this.hunters.children.iterate((hunter: Phaser.GameObjects.GameObject) => {
      if (hunter instanceof Hunter) {
        hunter.update(this);
      }
      return true;
    });
  }

  // Presentation only: particle textures, camera mood FX, and the burst
  // emitters used when a creature is eaten (blood) or reaches home (sparks).
  private setupFx(): void {
    if (!this.textures.exists("chd-spark")) {
      const g = this.make.graphics({ x: 0, y: 0 });
      g.fillStyle(0xffffff, 1);
      g.fillCircle(8, 8, 8);
      g.generateTexture("chd-spark", 16, 16);
      g.destroy();
    }
    if (!this.textures.exists("chd-blood")) {
      // Blood spatter for a kill — deep oxblood red.
      const g = this.make.graphics({ x: 0, y: 0 });
      g.fillStyle(0x9c1818, 1);
      g.fillCircle(6, 6, 6);
      g.generateTexture("chd-blood", 12, 12);
      g.destroy();
    }
    if (!this.textures.exists("chd-fog")) {
      // A big, soft grey-green mist blob with a gentle falloff. Many of these
      // are blended (with heavy overlap) into one continuous cloud, so no single
      // blob reads as a circle.
      const g = this.make.graphics({ x: 0, y: 0 });
      const R = 150;
      for (let r = R; r > 0; r--) {
        g.fillStyle(0x9aa890, 0.02 * (1 - r / R));
        g.fillCircle(R, R, r);
      }
      g.generateTexture("chd-fog", R * 2, R * 2);
      g.destroy();
    }
    // Eerie mood FX flags, toggleable in the options panel.
    this.loadFx();

    this.bloodEmitter = this.add
      .particles(0, 0, "chd-blood", {
        speed: { min: 30, max: 120 },
        angle: { min: 0, max: 360 },
        lifespan: 600,
        scale: { start: 0.9, end: 0 },
        alpha: { start: 0.95, end: 0 },
        gravityY: 60,
        emitting: false,
      })
      .setDepth(900);
    this.sparkEmitter = this.add
      .particles(0, 0, "chd-spark", {
        speed: { min: 15, max: 60 },
        angle: { min: 0, max: 360 },
        lifespan: 750,
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.9, end: 0 },
        gravityY: -50,
        tint: 0xe0b252,
        emitting: false,
      })
      .setDepth(900);

    const W = this.scale.width;
    const H = this.scale.height;

    // "mist": drifting particle fog spread across the field (the look that read
    // best). Slow, large, faint blobs of chd-fog, pre-aged so it's present at
    // the start.
    this.fogMist = this.add
      .particles(0, 0, "chd-fog", {
        x: { min: -150, max: W + 150 },
        y: { min: -150, max: H + 150 },
        speedX: { min: -8, max: 8 },
        speedY: { min: -5, max: 5 },
        lifespan: 18000,
        // Big, heavily overlapping blobs (300px texture x 1.8-3.8 ~= 540-1140px)
        // so the mist reads as continuous fog rather than small puffs.
        scale: { min: 1.8, max: 3.8 },
        alpha: { start: 0.55, end: 0.55 },
        frequency: 360,
        quantity: 1,
      })
      .setDepth(820);
    (this.fogMist as unknown as {
      fastForward: (t: number, d: number) => void;
    }).fastForward(18000, 16);

    // "cloud": one continuous baked cloud (blobs blended once into a texture),
    // drawn each tick at a slow ping-pong drift. Larger than the screen so no
    // edge shows. Rebaked each round; the RT is kept so the texture stays valid.
    const cw = Math.ceil(W * 1.4);
    const ch = Math.ceil(H * 1.4);
    this.fogCloudW = cw;
    this.fogCloudH = ch;
    if (this.fogCloud) {
      this.fogCloud.destroy();
    }
    if (this.textures.exists("chd-cloud")) {
      this.textures.remove("chd-cloud");
    }
    const cloud = this.make.renderTexture({ width: cw, height: ch }, false);
    const blobs = Math.round((cw * ch) / 9000);
    for (let i = 0; i < blobs; i++) {
      cloud.draw(
        "chd-fog",
        Phaser.Math.Between(-150, cw - 150),
        Phaser.Math.Between(-150, ch - 150),
        Phaser.Math.FloatBetween(0.4, 0.85)
      );
    }
    cloud.saveTexture("chd-cloud");
    this.fogCloud = cloud;
    this.fogRt = this.add
      .renderTexture(0, 0, W, H)
      .setOrigin(0, 0)
      .setDepth(820);

    // Off-screen brush used to erase soft holes in the cloud (fog parts around
    // the living). Never rendered itself; only its transform feeds rt.erase().
    if (this.fogBrush) {
      this.fogBrush.destroy();
    }
    this.fogBrush = this.add
      .image(-9999, -9999, "chd-fog")
      .setVisible(false);

    // Start both layers hidden and transparent so the first applyFx fades the
    // active one in cleanly (no pop on load).
    this.fogMist.setVisible(false);
    this.fogMist.alpha = 0;
    this.fogRt.setVisible(false).setAlpha(0);

    this.applyFx();
  }

  // Redraw the baked cloud (drifting) when the "cloud" style is active.
  private updateFog(): void {
    const rt = this.fogRt;
    if (!rt || this.fogStyle !== "cloud") {
      return;
    }
    const now = this.time.now;
    if (now - this.lastFogUpdate < 50) {
      return;
    }
    this.lastFogUpdate = now;
    const marginX = this.fogCloudW - this.scale.width;
    const marginY = this.fogCloudH - this.scale.height;
    const ox = -marginX * (0.5 + 0.5 * Math.sin(now / 9000));
    const oy = -marginY * (0.5 + 0.5 * Math.sin(now / 11000));
    rt.clear();
    rt.draw("chd-cloud", ox, oy, 1);
    // Fog parts around the living: punch a soft hole at every creature, hunter
    // and the skull, so fog only sits where they are not. The holes follow
    // them and the cloud flows back in once they move on (full redraw each
    // tick). erase() respects the brush's position + scale.
    const brush = this.fogBrush;
    if (brush) {
      const punch = (x: number, y: number, s: number) => {
        brush.setScale(s);
        brush.setPosition(x, y);
        rt.erase(brush);
      };
      (this.creatures.getChildren() as Phaser.GameObjects.GameObject[]).forEach(
        (c) => {
          const s = c as unknown as { active: boolean; x: number; y: number };
          if (s.active) {
            punch(s.x, s.y, 0.7);
          }
        }
      );
      (this.hunters.getChildren() as Phaser.GameObjects.GameObject[]).forEach(
        (h) => {
          const s = h as unknown as { active: boolean; x: number; y: number };
          if (s.active) {
            punch(s.x, s.y, 0.9);
          }
        }
      );
      const skull = this.player;
      if (skull) {
        punch(skull.x, skull.y, 1.4);
      }
    }
  }

  // Read the eerie-mood effect flags from localStorage. Each effect persists on
  // its own key; an old whole-mood "off" disables them all (back-compat).
  private loadFx(): void {
    try {
      if (localStorage.getItem("chd-mood") === "0") {
        this.fx = { vignette: false, grade: false };
        this.fogStyle = "off";
      }
      const read = (key: string, dflt: boolean) => {
        const v = localStorage.getItem(key);
        return v === null ? dflt : v === "1";
      };
      this.fx.vignette = read("chd-fx-vignette", this.fx.vignette);
      this.fx.grade = read("chd-fx-grade", this.fx.grade);
      const grass = localStorage.getItem("chd-grass");
      if (grass && GRASS_COLORS[grass]) {
        this.grassKey = grass;
      }
      const style = localStorage.getItem("chd-fog-style");
      if (style === "off" || style === "mist" || style === "cloud") {
        this.fogStyle = style;
      } else if (localStorage.getItem("chd-fx-fog") === "0") {
        this.fogStyle = "off"; // back-compat with the old on/off toggle
      }
    } catch (e) {
      /* ignore */
    }
  }

  public setFx(key: "vignette" | "grade", value: boolean): void {
    this.fx[key] = value;
    try {
      localStorage.setItem(`chd-fx-${key}`, value ? "1" : "0");
    } catch (e) {
      /* ignore */
    }
    this.applyFx();
  }

  public setFogStyle(style: string): void {
    this.fogStyle = style;
    try {
      localStorage.setItem("chd-fog-style", style);
    } catch (e) {
      /* ignore */
    }
    this.applyFx();
  }

  // Apply the enabled mood effects to the camera + fog. A tight, heavy vignette
  // closes the world in; a desaturating grade drains it to a grim old-world murk
  // (blood reds still read against the sickly green). WebGL only for the camera
  // grade; the fog is a plain particle layer that works either way.
  public setGrass(key: string): void {
    if (!GRASS_COLORS[key]) {
      return;
    }
    this.grassKey = key;
    try {
      localStorage.setItem("chd-grass", key);
    } catch (e) {
      /* ignore */
    }
    this.cameras.main.setBackgroundColor(GRASS_COLORS[key]);
  }

  // Fade a fog layer in or out (instead of popping). Tweens the layer's own
  // alpha; for the mist that's the emitter's GameObject alpha. onHidden runs
  // once a fade-out completes (used to clear the cloud render texture).
  private fadeFog(
    layer:
      | Phaser.GameObjects.Particles.ParticleEmitter
      | Phaser.GameObjects.RenderTexture
      | undefined,
    show: boolean,
    onHidden?: () => void
  ): void {
    if (!layer) {
      return;
    }
    this.tweens.killTweensOf(layer);
    if (show) {
      layer.setVisible(true);
      this.tweens.add({
        targets: layer,
        alpha: 1,
        duration: 700,
        ease: "Sine.easeOut",
      });
    } else {
      this.tweens.add({
        targets: layer,
        alpha: 0,
        duration: 700,
        ease: "Sine.easeIn",
        onComplete: () => {
          layer.setVisible(false);
          if (onHidden) {
            onHidden();
          }
        },
      });
    }
  }

  private applyFx(): void {
    this.cameras.main.setBackgroundColor(GRASS_COLORS[this.grassKey]);
    const cam = (this.cameras.main as unknown as { postFX?: PostFx }).postFX;
    if (cam) {
      cam.clear();
      if (this.fx.vignette) {
        // Gentle: wide radius, light strength — atmosphere, not a black tunnel.
        cam.addVignette(0.5, 0.5, 0.9, 0.32);
      }
      if (this.fx.grade) {
        const grade = cam.addColorMatrix();
        grade.saturate(-0.32);
        grade.brightness(0.86);
      }
    }
    // Fog layers fade in/out rather than popping. The cloud layer clears its
    // render texture only once it has fully faded out.
    this.fadeFog(this.fogMist, this.fogStyle === "mist");
    this.fadeFog(this.fogRt, this.fogStyle === "cloud", () => this.fogRt?.clear());
  }

  // Ongoing plant spawning during a level, driven from update() on a time
  // accumulator (0 amount = off), capped so the field can't grow without bound.
  // Reads the config each call, so edits apply immediately.
  private maybeAutoSpawn(): void {
    if (this.roundEnding) {
      return;
    }
    const amount = this.gameManager.getFoliageSpawnAmount();
    const rate = this.gameManager.getFoliageSpawnRateMs();
    if (amount <= 0 || rate <= 0) {
      return;
    }
    if (this.time.now - this.lastAutoSpawn < rate) {
      return;
    }
    this.lastAutoSpawn = this.time.now;
    if (this.foliage.countActive() < this.gameManager.getMaxFoliage()) {
      this.spawnFoliage(amount);
    }
  }

  // Fertilised soil: each death sprouts plants outward in widening rings over a
  // few ticks, as if the corpse enriched the ground. Spent entries are dropped.
  private updateFertilisers(): void {
    if (this.roundEnding || this.fertilisers.length === 0) {
      return;
    }
    const now = this.time.now;
    const maxFoliage = this.gameManager.getMaxFoliage();
    for (let i = this.fertilisers.length - 1; i >= 0; i--) {
      const f = this.fertilisers[i];
      if (now < f.next) {
        continue;
      }
      if (this.foliage.countActive() < maxFoliage) {
        f.ring++;
        // Wider ring each tick = growth spreading outward from the death.
        const sprouts = Math.min(1 + f.ring, 4);
        for (let s = 0; s < sprouts; s++) {
          const a = Phaser.Math.FloatBetween(0, Math.PI * 2);
          const d = 6 + f.ring * 10 + Phaser.Math.Between(-4, 4);
          this.plantOne(f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, false);
        }
      }
      f.left--;
      f.next = now + 300;
      if (f.left <= 0) {
        this.fertilisers.splice(i, 1);
      }
    }
  }

  // A short amber ring where the player plants food.
  private plantRipple(x: number, y: number): void {
    const ring = this.add
      .circle(x, y, 14, 0x000000, 0)
      .setStrokeStyle(2, 0xe0b252, 0.8)
      .setScale(0.3)
      .setDepth(800);
    this.tweens.add({
      targets: ring,
      scale: 1.5,
      alpha: 0,
      duration: 350,
      ease: "Cubic.out",
      onComplete: () => ring.destroy(),
    });
  }

  // Flush the central skull red on a kill, fading back to bone. Uses a counter
  // tween (not targeting the sprite) so it never disturbs the hover tween.
  private pulsePlayer(): void {
    const p = this.player;
    if (!p) {
      return;
    }
    this.tweens.addCounter({
      from: 0,
      to: 100,
      duration: 340,
      ease: "Quad.out",
      onUpdate: (tw) => {
        if (!p.active) {
          return;
        }
        const t = tw.getValue() / 100; // 0 = red, 1 = back to white
        const g = Math.round(40 + (255 - 40) * t);
        p.setTint(Phaser.Display.Color.GetColor(255, g, g));
      },
      onComplete: () => {
        if (p.active) {
          p.clearTint();
        }
      },
    });
  }

  // Briefly flash the DOM title red on a kill (it fades back via CSS). The
  // timer resets on each kill, so a storm of kills holds it red.
  private flashTitle(): void {
    const el = document.getElementById("topbar-title");
    if (!el) {
      return;
    }
    el.classList.add("kill-flash");
    if (this.titleFlashTimer) {
      clearTimeout(this.titleFlashTimer);
    }
    this.titleFlashTimer = setTimeout(
      () => el.classList.remove("kill-flash"),
      160
    );
  }

  private checkGameOverConditions(): void {
    if (this.roundEnding) {
      return;
    }
    // The field empties once every creature has either reached a home
    // (survived) or been eaten. That is the end of the level.
    if (this.creatures.countActive() === 0) {
      this.resolveLevel();
    }
  }

  // Decide the outcome of a finished day. Days are endless: any survivor (a
  // creature that reached a home) carries the flock into the next day. A day
  // with zero survivors ends the run. The day you reach is the high score.
  private resolveLevel(): void {
    this.roundEnding = true;
    const won = this.survivedThisLevel >= 1;
    // The current day counts as reached; record it as the high score.
    this.bestDay = Math.max(this.bestDay, this.level);
    this.saveBest();
    dlog("resolve", {
      level: this.level,
      survived: this.survivedThisLevel,
      eaten: this.eatenThisLevel,
      won,
    });

    if (won) {
      this.showEnd("HUNGER", true);
      this.endSubText = this.subtitle(
        `the ${this.ordinal(this.level)} day passed\n` +
          `survived ${this.survivedThisLevel}   eaten ${this.eatenThisLevel}`
      );
      this.time.delayedCall(2200, this.startNextLevel, [], this);
    } else {
      // Wiped out with no survivors: the run ends. A dark flash and a shudder,
      // then the final screen showing the day reached and the best ever.
      this.cameras.main.flash(500, 90, 18, 28);
      this.cameras.main.shake(400, 0.006);
      this.showEnd("DEATH", false);
      this.endSubText = this.subtitle(
        `the ${this.ordinal(this.level)} day\n` +
          `best day ${this.bestDay}   total survived ${this.totalSurvived}`
      );
      this.time.delayedCall(4200, this.restartGame, [], this);
    }
  }

  private saveBest(): void {
    try {
      localStorage.setItem("chd-best", String(this.bestDay));
    } catch (e) {
      /* ignore */
    }
  }

  private loadStats(): void {
    try {
      const raw = localStorage.getItem("chd-stats");
      if (!raw) {
        return;
      }
      const obj = JSON.parse(raw) as Partial<typeof this.stats>;
      this.stats = {
        runs: obj.runs ?? 0,
        survived: obj.survived ?? 0,
        eaten: obj.eaten ?? 0,
        planted: obj.planted ?? 0,
      };
    } catch (e) {
      /* ignore */
    }
  }

  private saveStats(): void {
    try {
      localStorage.setItem("chd-stats", JSON.stringify(this.stats));
    } catch (e) {
      /* ignore */
    }
  }

  // 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", etc.
  private ordinal(n: number): string {
    const suffixes = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
  }

  private showEnd(word: string, win: boolean): void {
    this.endText = this.add
      .text(this.scale.width / 2, this.scale.height / 2 - 40, word, {
        fontSize: "120px",
        color: win ? "#e0b252" : "#a21d2c",
        fontFamily: "Olde English",
      })
      .setOrigin(0.5)
      .setDepth(1000);
  }

  private subtitle(text: string): Phaser.GameObjects.Text {
    return this.add
      .text(this.scale.width / 2, this.scale.height / 2 + 80, text, {
        fontSize: "30px",
        color: "#ffffff",
        fontFamily: "Olde English",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(1000);
  }

  private updateHud(): void {
    const lvl = document.getElementById("hud-level");
    const surv = document.getElementById("hud-survived");
    const eaten = document.getElementById("hud-eaten");
    if (lvl) {
      lvl.textContent = `Day ${this.level}`;
    }
    if (surv) {
      surv.textContent = `Survived ${this.survivedThisLevel}`;
    }
    if (eaten) {
      eaten.textContent = `Eaten ${this.eatenThisLevel}`;
    }
  }

  // Wire the DOM top-bar buttons + config panel to the scene. Called from
  // create(), so onclick assignments are refreshed (not duplicated) on restart.
  private bindDomUi(): void {
    const byId = (id: string) => document.getElementById(id);
    const setVolLabel = () => {
      const b = byId("btn-vol");
      if (b) b.textContent = `vol: ${Math.round(this.masterVolume * 100)}`;
    };
    const setAudioLabel = () => {
      const b = byId("btn-audio");
      if (b) b.textContent = this.isMusicPlaying ? "audio: on" : "audio: off";
    };
    setVolLabel();
    setAudioLabel();

    const vol = byId("btn-vol");
    if (vol) {
      vol.onclick = () => {
        const steps = [1, 0.6, 0.3, 0];
        const i = steps.findIndex(
          (s) => Math.abs(s - this.masterVolume) < 0.01
        );
        this.masterVolume = steps[(i + 1) % steps.length];
        this.sound.volume = this.masterVolume;
        try {
          localStorage.setItem("chd-vol", String(this.masterVolume));
        } catch (e) {
          /* ignore */
        }
        setVolLabel();
      };
    }

    const options = byId("btn-options");
    if (options) {
      options.onclick = () => this.openOptions();
    }
    const optionsClose = byId("options-close");
    if (optionsClose) {
      optionsClose.onclick = () => this.closeOptions();
    }

    const audio = byId("btn-audio");
    if (audio) {
      audio.onclick = () => {
        if (this.isMusicPlaying) {
          this.music.pause();
        } else {
          this.music.play();
        }
        this.isMusicPlaying = !this.isMusicPlaying;
        setAudioLabel();
      };
    }

    const next = byId("btn-next");
    if (next) {
      next.onclick = () => this.startNextLevel();
    }
    const restart = byId("btn-restart");
    if (restart) {
      restart.onclick = () => this.restartGame();
    }
    const stats = byId("btn-stats");
    if (stats) {
      stats.onclick = () => this.openStats();
    }
    const statsClose = byId("stats-close");
    if (statsClose) {
      statsClose.onclick = () => this.closeStats();
    }
    const config = byId("btn-config");
    if (config) {
      config.onclick = () => this.openConfig();
    }
    const close = byId("config-close");
    if (close) {
      close.onclick = () => this.closeConfig();
    }
    const reset = byId("config-reset");
    if (reset) {
      reset.onclick = () => {
        this.gameManager.resetParams();
        this.buildConfigRows();
      };
    }
  }

  private openConfig(): void {
    this.buildConfigRows();
    const panel = document.getElementById("config-panel");
    if (panel) {
      panel.hidden = false;
    }
  }

  private openOptions(): void {
    this.buildOptionsRows();
    const panel = document.getElementById("options-panel");
    if (panel) {
      panel.hidden = false;
    }
  }

  private closeOptions(): void {
    const panel = document.getElementById("options-panel");
    if (panel) {
      panel.hidden = true;
    }
  }

  // The eerie-mood effects as individual checkboxes (broken out from the old
  // single "mood" toggle), plus they apply and persist live.
  private buildOptionsRows(): void {
    const host = document.getElementById("options-rows");
    if (!host) {
      return;
    }
    host.innerHTML = "";

    // Fog style selector (for testing the different looks).
    const fogRow = document.createElement("div");
    fogRow.className = "config-row";
    const fogLabel = document.createElement("label");
    fogLabel.textContent = "Fog style";
    const select = document.createElement("select");
    select.className = "config-select";
    for (const [val, text] of [
      ["off", "Off"],
      ["mist", "Mist (drifting)"],
      ["cloud", "Cloud (smooth)"],
    ]) {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = text;
      if (val === this.fogStyle) {
        o.selected = true;
      }
      select.appendChild(o);
    }
    select.onchange = () => this.setFogStyle(select.value);
    fogRow.appendChild(fogLabel);
    fogRow.appendChild(select);
    host.appendChild(fogRow);

    // Grass colour selector.
    const grassRow = document.createElement("div");
    grassRow.className = "config-row";
    const grassLabel = document.createElement("label");
    grassLabel.textContent = "Grass colour";
    const grassSelect = document.createElement("select");
    grassSelect.className = "config-select";
    for (const [val, text] of [
      ["murky", "Murky (old-world)"],
      ["classic", "Classic (green)"],
    ]) {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = text;
      if (val === this.grassKey) {
        o.selected = true;
      }
      grassSelect.appendChild(o);
    }
    grassSelect.onchange = () => this.setGrass(grassSelect.value);
    grassRow.appendChild(grassLabel);
    grassRow.appendChild(grassSelect);
    host.appendChild(grassRow);

    // The remaining mood effects as checkboxes.
    const opts: [string, "vignette" | "grade", boolean][] = [
      ["Vignette (closing dark)", "vignette", this.fx.vignette],
      ["Desaturate (grim grade)", "grade", this.fx.grade],
    ];
    for (const [label, key, value] of opts) {
      const row = document.createElement("div");
      row.className = "config-row";
      const l = document.createElement("label");
      l.textContent = label;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.onchange = () => this.setFx(key, input.checked);
      row.appendChild(l);
      row.appendChild(input);
      host.appendChild(row);
    }
  }

  private openStats(): void {
    this.buildStatsRows();
    const panel = document.getElementById("stats-panel");
    if (panel) {
      panel.hidden = false;
    }
  }

  private closeStats(): void {
    const panel = document.getElementById("stats-panel");
    if (panel) {
      panel.hidden = true;
    }
  }

  // Render the local stats as read-only rows. Best day comes from its own key;
  // the rest are the cumulative counters logged across runs.
  private buildStatsRows(): void {
    const host = document.getElementById("stats-rows");
    if (!host) {
      return;
    }
    const rows: [string, number][] = [
      ["Best day reached", this.bestDay],
      ["Runs played", this.stats.runs],
      ["Creatures survived (all time)", this.stats.survived],
      ["Creatures eaten (all time)", this.stats.eaten],
      ["Plants grown (all time)", this.stats.planted],
    ];
    host.innerHTML = "";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "config-row";
      const l = document.createElement("label");
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "stat-value";
      v.textContent = value.toLocaleString();
      row.appendChild(l);
      row.appendChild(v);
      host.appendChild(row);
    }
  }

  private closeConfig(): void {
    const panel = document.getElementById("config-panel");
    if (panel) {
      panel.hidden = true;
    }
  }

  // Build the config rows from the editable params. Edits apply live and persist.
  private buildConfigRows(): void {
    const host = document.getElementById("config-rows");
    if (!host) {
      return;
    }
    host.innerHTML = "";
    let lastSection = "";
    for (const param of this.gameManager.getEditableParams()) {
      if (param.section !== lastSection) {
        lastSection = param.section;
        const head = document.createElement("div");
        head.className = "config-section";
        head.textContent = param.section;
        host.appendChild(head);
      }
      const row = document.createElement("div");
      row.className = "config-row";
      const label = document.createElement("label");
      label.textContent = param.label;
      const input = document.createElement("input");
      if (param.type === "bool") {
        input.type = "checkbox";
        input.checked = param.get() !== 0;
        input.onchange = () =>
          this.gameManager.setParam(param.key, input.checked ? 1 : 0);
      } else {
        input.type = "number";
        input.min = String(param.min);
        input.max = String(param.max);
        input.step = String(param.step);
        input.value = String(param.get());
        input.oninput = () => {
          const v = parseFloat(input.value);
          if (!Number.isNaN(v)) {
            this.gameManager.setParam(param.key, v);
          }
        };
        // The master "Overall size" cascades to the individual size fields, so
        // rebuild the panel on commit to show their new values.
        if (param.key === "overallScale") {
          input.onchange = () => this.buildConfigRows();
        }
      }
      row.appendChild(label);
      row.appendChild(input);
      host.appendChild(row);
    }
  }

  private levelHunterCount(): number {
    return this.gameManager.getHunterCountForLevel(this.level);
  }

  private startGame(): void {
    this.roundEnding = false;
    this.clearEndText();
    this.lastGridUpdate = 0;
    this.stats.runs++; // a new run begins
    this.saveStats();
    this.level = 1;
    this.survivedThisLevel = 0;
    this.eatenThisLevel = 0;
    this.totalSurvived = 0;
    this.totalEaten = 0;
    this.survivorGenes = []; // a fresh run starts from base stock
    this.fertilisers = [];

    this.creatures.clear(true, true);
    this.hunters.clear(true, true);
    this.foliage.clear(true, true);
    this.homes.clear(true, true);
    this.deaths.clear(true, true);

    this.spawnHomes(4);
    this.spawnCreatures(this.gameManager.getInitialCreatures());
    for (let i = 0; i < this.levelHunterCount(); i++) {
      this.spawnHunter();
    }
    this.spawnFoliage(this.gameManager.getInitialFoliage());
    this.updateHud();
    this.cameras.main.fadeIn(500);
  }

  private startNextLevel(): void {
    this.roundEnding = false;
    this.clearEndText();
    this.level++;
    // The creatures that reached home are the ones that begin the next day,
    // each returning with its own genes (so mutations carry across days).
    const carriedGenes = this.survivorGenes;
    this.survivorGenes = [];
    this.survivedThisLevel = 0;
    this.eatenThisLevel = 0;
    this.fertilisers = [];

    // Clear the field: only the creatures that reached home begin the next day.
    // Any that were still out in the open do not carry.
    this.creatures.clear(true, true);
    this.hunters.clear(true, true);
    this.foliage.clear(true, true);
    this.deaths.clear(true, true);

    this.spawnFromGenes(carriedGenes);
    for (let i = 0; i < this.levelHunterCount(); i++) {
      this.spawnHunter();
    }
    this.spawnFoliage(this.gameManager.getRegularLevelFoliage());
    this.updateHud();
    this.cameras.main.fadeIn(500);
  }

  private restartGame(): void {
    this.scene.restart();
  }

  private clearEndText(): void {
    if (this.endText) {
      this.endText.destroy();
      this.endText = undefined;
    }
    if (this.endSubText) {
      this.endSubText.destroy();
      this.endSubText = undefined;
    }
  }
  public addCreature(creature: Creature): void {
    // Hard cap the flock (belt-and-braces with the check in reproduce).
    if (this.creatures.countActive() >= this.gameManager.getMaxCreatures()) {
      creature.destroy();
      return;
    }
    this.creatures.add(creature);
  }

  private spawnCreatures(count: number, texture = "creature"): void {
    for (let i = 0; i < count; i++) {
      const { x, y } = getRandomSpawnPoint(this);
      const creature = new Creature(
        this,
        x,
        y,
        texture,
        this.gameManager.getCreatureSpeed(),
        this.gameManager.getCreatureReproduceThreshold(),
        this.gameManager.getCreatureSpeedIncrement(),
        this.gameManager.getCreatureReproduceRange()
      );
      creature.setScale(this.gameManager.getCreatureSize() / creature.width);
      this.creatures.add(creature);
    }
  }

  // Respawn creatures from saved gene sets (the previous day's survivors), so
  // their mutated traits and colours persist into the new day.
  private spawnFromGenes(genes: CreatureGenes[]): void {
    for (const g of genes) {
      const { x, y } = getRandomSpawnPoint(this);
      const creature = new Creature(
        this,
        x,
        y,
        "creature",
        g.speed,
        g.reproduceThreshold,
        g.speedIncrement,
        [g.reproduceRange[0], g.reproduceRange[1]],
        g.geneHue,
        g.bodyScale,
        g.eatDuration
      );
      creature.setScale(
        (this.gameManager.getCreatureSize() * g.bodyScale) / creature.width
      );
      this.creatures.add(creature);
    }
  }

  public spawnHunter(x?: number, y?: number): void {
    // Use the given spot if provided (a kill location). The `!= null` guard
    // matters: `x && y` would treat an edge kill at x=0 or y=0 as "no location"
    // and instead spawn the hunter at a random edge, far from the kill.
    const position =
      x != null && y != null ? { x, y } : getRandomSpawnPoint(this, true);
    const W = this.scale.width;
    const H = this.scale.height;
    const adjustedX =
      position.x <= 0 ? 50 : position.x >= W ? W - 50 : position.x;
    const adjustedY =
      position.y <= 0 ? 50 : position.y >= H ? H - 50 : position.y;
    const hunter = new Hunter(
      this,
      adjustedX,
      adjustedY,
      "hunter",
      this.gameManager.getHunterSpeed()
    );
    hunter.setScale(this.gameManager.getHunterSize() / hunter.width);
    this.hunters.add(hunter);
  }

  // A hunter caught a creature: the creature dies, a death marker and a wail
  // appear, and one new hunter spawns where it fell (the intended spiral). The
  // `creature.active` guard means two hunters touching the same creature in one
  // frame still only kill it once.
  private handleHunterCreatureOverlap = (
    hunterObj: Phaser.GameObjects.GameObject | Phaser.Tilemaps.Tile,
    creatureObj: Phaser.GameObjects.GameObject | Phaser.Tilemaps.Tile
  ): void => {
    if (!(creatureObj instanceof Creature) || !creatureObj.active) {
      return;
    }
    // A hunter that just appeared can't kill yet. Without this, a hunter that
    // rises on top of a clustered prey kills it, spawns another hunter on the
    // next prey, and so on, all in the same instant (1 hunter becomes 10).
    if (
      hunterObj instanceof Hunter &&
      this.time.now - hunterObj.bornAt < this.gameManager.getHunterSpawnGraceMs()
    ) {
      return;
    }
    const { x, y } = creatureObj;
    creatureObj.destroy();
    this.eatenThisLevel++;
    this.totalEaten++;
    this.stats.eaten++;
    this.updateHud();

    // Throttle + cap the wail so a swarm of simultaneous kills doesn't stack
    // into one blaring, amplified wave of audio.
    if (this.time.now - this.lastWailAt > 120) {
      this.lastWailAt = this.time.now;
      const wail = Phaser.Math.RND.pick(["wail1", "wail2"]);
      this.sound.play(wail, { volume: 0.45 });
    }

    this.spawnDeath(x, y);
    // The corpse fertilises the soil: plants will sprout outward from here.
    this.fertilisers.push({
      x,
      y,
      next: this.time.now + 350,
      ring: 0,
      left: Phaser.Math.Between(4, 6),
    });
    this.bloodEmitter.explode(8, x, y);
    this.pulsePlayer();
    this.flashTitle();
    this.spawnHunter(x, y);
    dlog("kill", {
      x: Math.round(x),
      y: Math.round(y),
      creatures: this.creatures.countActive(),
      hunters: this.hunters.countActive(),
      preyNear: this.preyNear(x, y, 60),
      eaten: this.eatenThisLevel,
    });
  };

  // How many live creatures are within `r` px of a point. Used by the debug log
  // to confirm whether kills are happening inside a cluster.
  private preyNear(x: number, y: number, r: number): number {
    let n = 0;
    (this.creatures.getChildren() as Creature[]).forEach((c) => {
      if (c.active && Phaser.Math.Distance.Between(x, y, c.x, c.y) <= r) {
        n++;
      }
    });
    return n;
  }

  // Two full creatures touching each other both reproduce.

  private spawnFoliage(count: number): void {
    for (let i = 0; i < count; i++) {
      const { x, y } = getRandomSpawnPoint(this);
      const foliage = new Foliage(
        this,
        x,
        y,
        `foliage${Phaser.Math.Between(1, 9)}`
      );
      foliage.setScale(this.gameManager.getFoliageSize() / foliage.width);
      this.foliage.add(foliage);
      this.physics.add.existing(foliage);
    }
  }

  // Create a single plant at a world position (no ripple). Shared by the
  // tap-to-plant and the press-and-hold stream.
  private plantOne(x: number, y: number, counted = true): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const px = Phaser.Math.Clamp(x, 6, W - 6);
    const py = Phaser.Math.Clamp(y, 6, H - 6);
    const foliage = new Foliage(
      this,
      px,
      py,
      `foliage${Phaser.Math.Between(1, 9)}`
    );
    foliage.setScale(this.gameManager.getFoliageSize() / foliage.width);
    this.foliage.add(foliage);
    this.physics.add.existing(foliage);
    if (counted) {
      this.stats.planted++; // player-grown plants, logged locally
    }
  }

  private spawnFoliageAtPointer(pointer: Phaser.Input.Pointer): void {
    const { x, y } = pointer.positionToCamera(
      this.cameras.main
    ) as Phaser.Math.Vector2;
    this.plantOne(x, y);
    this.plantRipple(x, y);
  }

  private handleLongPress(pointer: Phaser.Input.Pointer): void {
    if (!this.longPressTimer) {
      this.longPressTimer = this.time.delayedCall(
        100,
        () => {
          // Start spawning foliage continuously
          this.spawnFoliageStream(pointer);
        },
        [],
        this
      );
    }
  }

  private spawnFoliageStream(pointer: Phaser.Input.Pointer): void {
    // Hold to lay down a dense trail: a small clump every tick, following the
    // pointer (so a drag paints growth). Works with mouse and touch alike.
    this.foliageStreamTimer = this.time.addEvent({
      delay: 55,
      callback: () => {
        const { x, y } = pointer.positionToCamera(
          this.cameras.main
        ) as Phaser.Math.Vector2;
        for (let i = 0; i < 4; i++) {
          this.plantOne(
            x + Phaser.Math.Between(-26, 26),
            y + Phaser.Math.Between(-26, 26)
          );
        }
        this.plantRipple(x, y);
      },
      callbackScope: this,
      loop: true,
    });
  }

  public getPathGrid(): number[][] {
    return this.pathGrid;
  }

  // Save any creature sitting on a home. Homes have no physics body, so this
  // proximity check replaces the (never-firing) arcade overlap.
  private checkHomeArrivals(): void {
    const homes = this.homes.getChildren() as Home[];
    if (homes.length === 0) {
      return;
    }
    // A creature counts as home once it touches the home sprite: half the home
    // plus a little for the creature's own body. Scales with the home size.
    const saveRadius = this.gameManager.getHomeSize() / 2 + 16;
    // Snapshot, because saveCreature() destroys creatures mid-iteration.
    const creatures = [...this.creatures.getChildren()] as Creature[];
    for (const creature of creatures) {
      if (!creature.active) {
        continue;
      }
      for (const home of homes) {
        if (
          Phaser.Math.Distance.Between(creature.x, creature.y, home.x, home.y) <=
          saveRadius
        ) {
          this.saveCreature(creature);
          break;
        }
      }
    }
  }

  private saveCreature(creature: Creature): void {
    const { x, y } = creature;
    // Remember its genes so it (and its mutations) return next day.
    this.survivorGenes.push(creature.getGenes());
    creature.destroy();
    this.sparkEmitter.explode(12, x, y);
    this.survivedThisLevel++;
    this.totalSurvived++;
    this.stats.survived++;
    this.updateHud();
    dlog("save", {
      creatures: this.creatures.countActive(),
      survived: this.survivedThisLevel,
    });
  }

  // The four corner sanctuaries, inset from the edges of the current world.
  private homeCorners(): { x: number; y: number }[] {
    const W = this.scale.width;
    const H = this.scale.height;
    const pad = 50;
    return [
      { x: pad, y: pad },
      { x: W - pad, y: pad },
      { x: pad, y: H - pad },
      { x: W - pad, y: H - pad },
    ];
  }

  private spawnHomes(count: number): void {
    const homePositions = this.homeCorners();
    for (let i = 0; i < count; i++) {
      const { x, y } = homePositions[i];
      const home = new Home(this, x, y, "home");
      home.setScale(this.gameManager.getHomeSize() / home.width);
      // The corner sanctuaries glow softly (WebGL only).
      const fx = (home as unknown as { postFX?: PostFx }).postFX;
      if (fx) {
        fx.addGlow(0xe0b252, 4, 0, false, 0.1, 12);
      }
      this.homes.add(home);
    }
  }

  public spawnDeath(x: number, y: number): void {
    const death = new Death(this, x, y, "death");
    death.setScale(this.gameManager.getDeathSize() / death.width);
    this.deaths.add(death);
  }

  public getHomes(): Phaser.GameObjects.Group {
    return this.homes;
  }
}
