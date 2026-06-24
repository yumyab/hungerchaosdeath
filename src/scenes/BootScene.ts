import Phaser from "phaser";

// Loads only the skull up front (tiny), so the PreloadScene can show it hovering
// on the field while the heavier assets (music, sprites) stream in.
export default class BootScene extends Phaser.Scene {
  constructor() {
    super("BootScene");
  }

  preload(): void {
    this.load.image("player", "assets/player.png");
  }

  create(): void {
    this.scene.start("PreloadScene");
  }
}
