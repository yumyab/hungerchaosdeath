// StartScene.ts
import Phaser from "phaser";
import GameManager from "./GameManager";

export default class StartScene extends Phaser.Scene {
  // Title-screen sprites are drawn much bigger than in-game for a zoomed-in look.
  private readonly bigScale = 2.8;
  private startButton: Phaser.GameObjects.Text;
  music:
    | Phaser.Sound.NoAudioSound
    | Phaser.Sound.HTML5AudioSound
    | Phaser.Sound.WebAudioSound;

  constructor() {
    super("StartScene");
  }

  public create(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    // Grass colour to match the game (respecting the options-panel choice).
    let grass = "#243524";
    try {
      const key = localStorage.getItem("chd-grass");
      if (key === "classic") {
        grass = "#2e8b57";
      }
    } catch (e) {
      /* ignore */
    }
    this.cameras.main.setBackgroundColor(grass);

    // Match the game's eerie mood (respecting the per-effect toggles) so the
    // title screen and the game look like the same grim world. WebGL only.
    const readFx = (key: string) => {
      try {
        if (localStorage.getItem("chd-mood") === "0") {
          return false;
        }
        const v = localStorage.getItem(key);
        return v === null ? true : v === "1";
      } catch (e) {
        return true;
      }
    };
    const fx = (
      this.cameras.main as unknown as {
        postFX?: {
          addVignette: (x: number, y: number, r: number, s: number) => unknown;
          addColorMatrix: () => {
            saturate: (v: number, m?: boolean) => unknown;
            brightness: (v: number, m?: boolean) => unknown;
          };
        };
      }
    ).postFX;
    if (fx) {
      if (readFx("chd-fx-vignette")) {
        fx.addVignette(0.5, 0.5, 0.9, 0.32);
      }
      if (readFx("chd-fx-grade")) {
        const grade = fx.addColorMatrix();
        grade.saturate(-0.32);
        grade.brightness(0.86);
      }
    }
    if (readFx("chd-fx-fog")) {
      this.spawnFog();
    }

    // Title / button sizes scale with the canvas width, so changing the game
    // resolution no longer shrinks the title screen.
    const titleSize = Math.round(W * 0.078); // ~94px at 1200 wide
    const buttonSize = Math.round(W * 0.044); // ~53px
    // Add game title
    const title = this.add.text(W / 2, H * 0.33, "Hunger. Chaos. Death.", {
      fontSize: `${titleSize}px`,
      fontFamily: "Olde English",
      color: "#ece6da",
    });
    title.setOrigin(0.5);

    // Add start button
    this.startButton = this.add
      .text(W / 2, H * 0.6, "Start", {
        fontSize: `${buttonSize}px`,
        color: "#ece6da",
        fontFamily: "Olde English",
      })
      .setOrigin(0.5)
      .setInteractive();
    this.music = this.sound.add("music", { loop: true });
    const begin = () => {
      this.scene.start("GameScene");
      this.music.play();
    };
    this.startButton.on("pointerdown", begin);
    // Clicking anywhere also starts, so a tap doesn't have to hit the word.
    this.input.on("pointerdown", begin);

    // A few big shrubs and a single hunter, scaled up for the zoomed-in look.
    this.spawnFoliage(26);
    this.spawnHunter(1);
  }

  // A drifting fog of soft pixel blobs, matching the in-game mist.
  private spawnFog(): void {
    if (!this.textures.exists("chd-fog")) {
      const g = this.make.graphics({ x: 0, y: 0 });
      const R = 32;
      for (let r = R; r > 0; r--) {
        g.fillStyle(0x9aa890, 0.05 * (1 - r / R));
        g.fillCircle(R, R, r);
      }
      g.generateTexture("chd-fog", R * 2, R * 2);
      g.destroy();
    }
    const W = this.scale.width;
    const H = this.scale.height;
    const fog = this.add
      .particles(0, 0, "chd-fog", {
        x: { min: -100, max: W + 100 },
        y: { min: -100, max: H + 100 },
        speedX: { min: -10, max: 10 },
        speedY: { min: -5, max: 5 },
        lifespan: 16000,
        scale: { min: 3, max: 7 },
        alpha: { start: 0.55, end: 0.55 },
        frequency: 650,
        quantity: 1,
      })
      .setDepth(820);
    (fog as unknown as { fastForward: (t: number, d: number) => void }).fastForward(
      12000,
      16
    );
  }

  private spawnFoliage(count: number): void {
    for (let i = 0; i < count; i++) {
      const { x, y } = this.getRandomSpawnPoint();
      const foliage = new Phaser.GameObjects.Sprite(
        this,
        x,
        y,
        `foliage${Phaser.Math.Between(1, 9)}`
      );
      foliage.setScale(
        (GameManager.getInstance().getFoliageSize() * this.bigScale) /
          foliage.width
      );
      this.add.existing(foliage);
    }
  }

  private spawnHunter(count: number): void {
    for (let i = 0; i < count; i++) {
      const { x, y } = this.getRandomSpawnPoint();
      const hunter = new Phaser.GameObjects.Sprite(this, x, y, "hunter");
      hunter.setScale(
        (GameManager.getInstance().getHunterSize() * this.bigScale) /
          hunter.width
      );
      this.add.existing(hunter);
    }
  }

  private getRandomSpawnPoint(): { x: number; y: number } {
    const x = Phaser.Math.Between(50, this.scale.width - 50);
    const y = Phaser.Math.Between(50, this.scale.height - 50);
    return { x, y };
  }
}
