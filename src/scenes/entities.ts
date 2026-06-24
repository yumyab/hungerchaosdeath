import Phaser from "phaser";
import GameScene from "./GameScene";
import GameManager from "./GameManager";
import { findPath, getNearestEntity, getRandomSpawnPoint } from "./utils";
import { dlog } from "./debug";

type Waypoint = { x: number; y: number };

// A creature's heritable traits, carried to offspring and across days.
export type CreatureGenes = {
  speed: number;
  speedIncrement: number;
  reproduceThreshold: number;
  reproduceRange: [number, number];
  geneHue: number;
  bodyScale: number;
  eatDuration: number;
};

// Anything that walks the grid: it keeps a cached easystar path and the
// bookkeeping `steer()` needs to follow it.
type PathMover = Phaser.Physics.Arcade.Sprite & {
  path: Waypoint[];
  repathAt: number;
  goalKey: string;
  computing: boolean;
  speed: number;
};

// Continuous-velocity path following. We still route with easystar (so placed
// plants wall things off), but instead of tweening segment by segment we drive
// the body's velocity toward the next waypoint every frame. That removes the
// per-waypoint stutter and lets the caller change the goal at any time, which
// is what makes fleeing possible. The path is only recomputed when the goal
// changes, the path runs out, or a short cooldown elapses.
function steer(
  scene: GameScene,
  mover: PathMover,
  goalX: number,
  goalY: number,
  goalKey: string
): void {
  const now = scene.time.now;
  if (
    !mover.computing &&
    (goalKey !== mover.goalKey ||
      mover.path.length === 0 ||
      now >= mover.repathAt)
  ) {
    mover.computing = true;
    mover.goalKey = goalKey;
    mover.repathAt = now + 300;
    findPath(
      scene,
      mover.x,
      mover.y,
      goalX,
      goalY,
      scene.getPathGrid(),
      (path) => {
        mover.path = path;
        mover.computing = false;
      }
    );
  }

  // Drop waypoints we have effectively reached.
  while (
    mover.path.length > 0 &&
    Phaser.Math.Distance.Between(
      mover.x,
      mover.y,
      mover.path[0].x,
      mover.path[0].y
    ) <= 10
  ) {
    mover.path.shift();
  }

  // Steer toward the next waypoint, or straight at the goal while a fresh path
  // is still being computed.
  const target = mover.path.length > 0 ? mover.path[0] : { x: goalX, y: goalY };
  const body = mover.body as Phaser.Physics.Arcade.Body;
  const angle = Math.atan2(target.y - mover.y, target.x - mover.x);
  // speed is in pixels per second.
  body.setVelocity(Math.cos(angle) * mover.speed, Math.sin(angle) * mover.speed);
}

export class Creature extends Phaser.Physics.Arcade.Sprite {
  private reproduceThreshold: number;
  private speedIncrement: number;
  private reproduceRange: [number, number];
  private foliageEaten = 0;
  // Lifetime tallies that enforce "one plant only ever makes one creature":
  // a creature can never birth more offspring than the plants it has consumed.
  private plantsConsumed = 0;
  private offspringMade = 0;
  public speed: number;
  // Heritable genes, drifted on breeding when mutations are enabled.
  // geneHue: -1 = untinted (base stock); otherwise a 0..359 hue passed down so
  // lineages take on a visible tint. bodyScale: a small size multiplier.
  public geneHue = -1;
  public bodyScale = 1;
  public eatDuration: number; // ms per bite; heritable + mutatable
  public isEating = false;
  private eatStartAt = 0; // when the current bite began (scene clock)
  private eatingFoliage: Foliage | null = null;
  private fleeing = false;
  // Cached nearest-entity lookups, refreshed on a stagger so the O(plants) and
  // O(hunters) scans don't run for every creature every frame.
  private nearestHunter: Hunter | null = null;
  private targetFoliage: Foliage | null = null;
  private nextThink = 0;
  // movement state read/written by steer()
  public path: Waypoint[] = [];
  public repathAt = 0;
  public goalKey = "";
  public computing = false;

  constructor(
    scene: GameScene,
    x: number,
    y: number,
    texture: string,
    speed: number,
    reproduceThreshold: number,
    speedIncrement: number,
    reproduceRange: [number, number],
    geneHue = -1,
    bodyScale = 1,
    eatDuration = GameManager.getInstance().getCreatureEatingDuration()
  ) {
    super(scene, x, y, texture);
    this.setOrigin(0.5);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setCircle(16);
    (this.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true);
    this.speed = speed;
    this.reproduceThreshold = reproduceThreshold;
    this.speedIncrement = speedIncrement;
    this.reproduceRange = reproduceRange;
    this.geneHue = geneHue;
    this.bodyScale = bodyScale;
    this.eatDuration = eatDuration;
    if (geneHue >= 0) {
      // Tint toward the lineage's hue, but muted and dim (low saturation/value)
      // so mutations read as sickly, bruised, old-world tones — not cartoon
      // rainbow. Untinted base stock keeps its original sprite colours.
      this.setTint(
        Phaser.Display.Color.HSVToRGB(geneHue / 360, 0.4, 0.62).color as number
      );
    }
  }

  public update(gameScene: GameScene): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    const now = gameScene.time.now;

    // Refresh the expensive nearest-entity scans a few times a second (staggered
    // per creature), then reuse the cached targets in between. The distance to a
    // cached target is still checked every frame, so reactions stay responsive.
    if (now >= this.nextThink) {
      this.nearestHunter = getNearestEntity<Hunter>(gameScene.hunters, this) ?? null;
      this.targetFoliage = getNearestEntity<Foliage>(gameScene.foliage, this) ?? null;
      this.nextThink = now + 130 + Phaser.Math.Between(0, 90);
    } else if (this.targetFoliage && !this.targetFoliage.active) {
      // The plant we were heading for got eaten — pick a new one now.
      this.targetFoliage = getNearestEntity<Foliage>(gameScene.foliage, this) ?? null;
    }

    // Threat check runs every frame and overrides everything else.
    const hunter = this.nearestHunter;
    if (hunter && hunter.active && this.isHunterNearby(hunter)) {
      if (!this.fleeing) {
        this.fleeing = true;
        dlog("flee", {
          dist: Math.round(
            Phaser.Math.Distance.Between(this.x, this.y, hunter.x, hunter.y)
          ),
        });
      }
      // drop whatever it was doing and run for a home, releasing any plant it
      // had claimed so another creature can eat it.
      if (this.eatingFoliage) {
        this.eatingFoliage.claimed = false;
      }
      this.isEating = false;
      this.eatingFoliage = null;
      const home = getNearestEntity<Home>(gameScene.homes, this);
      if (home) {
        steer(gameScene, this, home.x, home.y, "flee");
      } else {
        const edge = getRandomSpawnPoint(gameScene, true);
        steer(gameScene, this, edge.x, edge.y, "flee");
      }
      return;
    }
    this.fleeing = false;

    // Eating: hold still until the bite has lasted long enough, then finish it.
    // Driven from update() rather than a per-bite timer (those proved flaky).
    if (this.isEating) {
      body.setVelocity(0, 0);
      if (now - this.eatStartAt >= this.eatDuration) {
        this.finishEating(gameScene);
      }
      return;
    }

    // Otherwise graze toward the nearest plant (cached), or drift home if none.
    const foliage = this.targetFoliage;
    if (foliage && foliage.active) {
      const d = Phaser.Math.Distance.Between(
        this.x,
        this.y,
        foliage.x,
        foliage.y
      );
      const eatRange = GameManager.getInstance().getFoliageSize() / 2 + 14;
      if (d <= eatRange) {
        // Close enough: eat it. We test by distance, not the physics body,
        // because most plant textures scale down to a sub-pixel body that an
        // overlap would almost never catch.
        body.setVelocity(0, 0);
        this.handleFoliageOverlap(foliage);
      } else {
        // The plant is both the target and a path obstacle, so pathfinding
        // routes the creature around it forever (the circling/trapped bug).
        // Grazing steers straight in instead. Fleeing and hunters still
        // pathfind, so plants still wall those off.
        this.moveDirect(foliage.x, foliage.y);
      }
      return;
    }
    const home = getNearestEntity<Home>(gameScene.homes, this);
    if (home) {
      steer(gameScene, this, home.x, home.y, "home");
      return;
    }
    body.setVelocity(0, 0);
  }

  private moveDirect(tx: number, ty: number): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    const a = Math.atan2(ty - this.y, tx - this.x);
    body.setVelocity(Math.cos(a) * this.speed, Math.sin(a) * this.speed);
  }

  private isHunterNearby(hunter: Hunter): boolean {
    return (
      Phaser.Math.Distance.Between(this.x, this.y, hunter.x, hunter.y) <=
      GameManager.getInstance().getHunterFearRadius()
    );
  }

  public handleFoliageOverlap(foliage: Foliage): void {
    // Don't stop to eat while fleeing, and don't eat a plant another creature
    // has already claimed (so one plant only ever feeds one creature).
    if (this.isEating || this.fleeing || foliage.claimed) {
      return;
    }
    foliage.claimed = true;
    this.isEating = true;
    this.eatStartAt = this.scene.time.now;
    this.eatingFoliage = foliage;
    (this.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
  }

  // Finish the current bite: consume the plant, grow a little faster, and breed
  // once full. Called from update() when the bite has lasted long enough.
  private finishEating(gameScene: GameScene): void {
    const eaten = this.eatingFoliage;
    this.eatingFoliage = null;
    this.isEating = false;
    if (eaten && eaten.active) {
      eaten.destroy();
    }
    this.foliageEaten++;
    this.plantsConsumed++;
    // Eating speeds the creature up toward the cap, but never slows a creature
    // that's already faster than the cap (a fast mutant keeps its speed).
    const cap = GameManager.getInstance().getCreatureMaxSpeed();
    if (this.speed < cap) {
      this.speed = Math.min(this.speed + this.speedIncrement, cap);
    }
    if (this.isFull()) {
      this.reproduce(gameScene);
    }
  }

  public isFull(): boolean {
    return this.foliageEaten >= this.reproduceThreshold;
  }

  // The heritable trait set, so survivors can be respawned next day unchanged.
  public getGenes(): CreatureGenes {
    return {
      speed: this.speed,
      speedIncrement: this.speedIncrement,
      reproduceThreshold: this.reproduceThreshold,
      reproduceRange: [this.reproduceRange[0], this.reproduceRange[1]],
      geneHue: this.geneHue,
      bodyScale: this.bodyScale,
      eatDuration: this.eatDuration,
    };
  }

  public reproduce(gameScene: GameScene): void {
    // Don't breed past the flock cap (keeps the framerate from collapsing).
    if (
      gameScene.creatures.countActive() >=
      GameManager.getInstance().getMaxCreatures()
    ) {
      this.foliageEaten = 0;
      return;
    }
    const gm = GameManager.getInstance();
    const [lo, hi] = this.reproduceRange;
    // Hard ceiling: never make more creatures over a lifetime than plants eaten,
    // so a single plant can only ever yield a single creature (the clamp).
    const allowance = this.plantsConsumed - this.offspringMade;
    const numOffspring = Math.max(0, Math.min(Phaser.Math.Between(lo, hi), allowance));
    dlog("birth", { n: numOffspring, x: Math.round(this.x), y: Math.round(this.y) });
    for (let i = 0; i < numOffspring; i++) {
      // Spread offspring out a little so the flock doesn't stack on one point
      // (a tight stack is what let a single hunter wipe everything at once).
      const ox = Phaser.Math.Clamp(
        this.x + Phaser.Math.Between(-24, 24),
        20,
        gameScene.scale.width - 20
      );
      const oy = Phaser.Math.Clamp(
        this.y + Phaser.Math.Between(-24, 24),
        20,
        gameScene.scale.height - 20
      );

      // Offspring inherit the parent's traits, occasionally mutated. Every
      // relevant trait drifts: speed swings hard (both faster and slower),
      // while size only deviates slightly. Mutated lineages also take on a
      // heritable colour so you can watch them spread and compete.
      let cSpeed = this.speed;
      let cIncrement = this.speedIncrement;
      let cThreshold = this.reproduceThreshold;
      let cRange: [number, number] = [
        this.reproduceRange[0],
        this.reproduceRange[1],
      ];
      let cScale = this.bodyScale;
      let cEat = this.eatDuration;
      let cHue = this.geneHue;
      if (
        gm.getMutationsEnabled() &&
        Phaser.Math.FloatBetween(0, 1) < gm.getMutationChance()
      ) {
        const amt = gm.getMutationAmount();
        // Drift a base value by ±amt, amplified by `factor`.
        const drift = (base: number, factor: number) =>
          base * (1 + Phaser.Math.FloatBetween(-amt, amt) * factor);
        // Speed mutates drastically, in both directions.
        cSpeed = Phaser.Math.Clamp(drift(this.speed, 2.2), 20, 400);
        cIncrement = Phaser.Math.Clamp(drift(this.speedIncrement, 1.4), 0, 80);
        cEat = Phaser.Math.Clamp(drift(this.eatDuration, 1.2), 20, 2000);
        cThreshold = Phaser.Math.Clamp(
          Math.round(drift(this.reproduceThreshold, 1)),
          1,
          20
        );
        const rl = Phaser.Math.Clamp(
          Math.round(drift(this.reproduceRange[0], 1)),
          0,
          8
        );
        const rh = Phaser.Math.Clamp(
          Math.round(drift(this.reproduceRange[1], 1)),
          Math.max(1, rl),
          8
        );
        cRange = [rl, rh];
        // Size: small deviations only, kept in a tight band so it never gets
        // silly (per feedback).
        cScale = Phaser.Math.Clamp(drift(this.bodyScale, 0.35), 0.8, 1.3);
        if (cHue < 0) {
          cHue = Phaser.Math.Between(0, 359); // first tint in this lineage
        } else {
          const shift = Math.round(amt * 180);
          cHue = (cHue + Phaser.Math.Between(-shift, shift) + 360) % 360;
        }
      }

      const offspring = new Creature(
        gameScene,
        ox,
        oy,
        this.texture.key,
        cSpeed,
        cThreshold,
        cIncrement,
        cRange,
        cHue,
        cScale,
        cEat
      );
      offspring.setScale((gm.getCreatureSize() * cScale) / offspring.width);
      gameScene.addCreature(offspring);
    }
    this.offspringMade += numOffspring;
    this.foliageEaten = 0;
  }
}

export class Hunter extends Phaser.Physics.Arcade.Sprite {
  public speed: number;
  // Time (scene clock) the hunter appeared. A freshly spawned hunter can't kill
  // for a short grace period, so one that rises on top of a clustered prey
  // doesn't instantly wipe the whole cluster in the same frame.
  public bornAt = 0;
  // movement state read/written by steer()
  public path: Waypoint[] = [];
  public repathAt = 0;
  public goalKey = "";
  public computing = false;
  private targetCreature: Creature | null = null;
  private nextThink = 0;

  constructor(
    scene: GameScene,
    x: number,
    y: number,
    texture: string,
    speed: number
  ) {
    super(scene, x, y, texture);
    this.setOrigin(0.5);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    (this.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true);
    this.speed = speed;
    this.bornAt = scene.time.now;
    // Killing creatures is handled by one group-level overlap in GameScene.
  }

  public update(gameScene: GameScene): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    const now = gameScene.time.now;
    // Re-pick a prey a few times a second instead of scanning all creatures
    // every frame; keep chasing the cached one in between.
    if (
      now >= this.nextThink ||
      !this.targetCreature ||
      !this.targetCreature.active
    ) {
      this.targetCreature =
        getNearestEntity<Creature>(gameScene.creatures, this) ?? null;
      this.nextThink = now + 130 + Phaser.Math.Between(0, 90);
    }
    if (!this.targetCreature) {
      body.setVelocity(0, 0);
      return;
    }
    steer(gameScene, this, this.targetCreature.x, this.targetCreature.y, "chase");
  }
}

export class Foliage extends Phaser.Physics.Arcade.Sprite {
  // Claimed by the one creature eating it, so a single plant can't feed (and
  // breed) several creatures at once.
  public claimed = false;

  constructor(scene: Phaser.Scene, x: number, y: number, texture: string) {
    super(scene, x, y, texture);
    this.setOrigin(0.5);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setCircle(32); // Set the collision body size
  }
}

export class Home extends Phaser.GameObjects.Sprite {
  constructor(scene: Phaser.Scene, x: number, y: number, texture: string) {
    super(scene, x, y, texture);
    this.setOrigin(0.5);
    scene.add.existing(this);
  }
}

export class Death extends Phaser.GameObjects.Sprite {
  constructor(scene: GameScene, x: number, y: number, texture: string) {
    super(scene, x, y, texture);
    this.setOrigin(0.5);
    scene.add.existing(this);
  }
}
