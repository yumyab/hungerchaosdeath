import Phaser from "phaser";

// Shows the skull hovering on the murky field while the rest of the assets load,
// then fades out so the title screen fades in behind it. The skull texture is
// already loaded by BootScene, so it's available to display here.
export default class PreloadScene extends Phaser.Scene {
  private startedAt = 0;

  constructor() {
    super("PreloadScene");
  }

  preload(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    // The field: the same murky old-world green as the game (respecting the
    // grass-colour option).
    let grass = "#243524";
    try {
      if (localStorage.getItem("chd-grass") === "classic") {
        grass = "#2e8b57";
      }
    } catch (e) {
      /* ignore */
    }
    this.cameras.main.setBackgroundColor(grass);

    // The skull, hovering and breathing at the centre of the field.
    const skull = this.add.image(W / 2, H / 2, "player").setOrigin(0.5);
    skull.setScale(150 / skull.width);
    this.tweens.add({
      targets: skull,
      y: H / 2 - 14,
      duration: 1700,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.tweens.add({
      targets: skull,
      alpha: 0.55,
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.startedAt = this.time.now;

    // The heavier assets stream in while the skull hovers above.
    this.load.image("creature", "assets/creature.png");
    this.load.image("home", "assets/home.png");
    this.load.image("hunter", "assets/hunter.png");
    this.load.image("foliage1", "assets/foliage1.png");
    this.load.image("foliage2", "assets/foliage2.png");
    this.load.image("foliage3", "assets/foliage3.png");
    this.load.image("foliage4", "assets/foliage4.png");
    this.load.image("foliage5", "assets/foliage5.png");
    this.load.image("foliage6", "assets/foliage6.png");
    this.load.image("foliage7", "assets/foliage7.png");
    this.load.image("foliage8", "assets/foliage8.png");
    this.load.image("foliage9", "assets/foliage9.png");
    this.load.image("death", "assets/death.png");
    this.load.audio("music", "assets/music.mp3");
    this.load.audio("wail1", "assets/wail1.mp3");
    this.load.audio("wail2", "assets/wail2.mp3");
  }

  create(): void {
    // Hold the loading screen for a moment even on a fast/cached load, so the
    // skull is seen, then fade out — the title screen fades in behind it.
    const minShownMs = 900;
    const wait = Math.max(0, minShownMs - (this.time.now - this.startedAt));
    this.time.delayedCall(wait, () => {
      this.cameras.main.fadeOut(700, 4, 6, 14);
      this.cameras.main.once("camerafadeoutcomplete", () => {
        this.scene.start("StartScene");
      });
    });
  }
}
