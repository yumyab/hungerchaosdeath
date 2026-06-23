import Phaser from "phaser";

export default class PreloadScene extends Phaser.Scene {
  constructor() {
    super("PreloadScene");
  }

  preload() {
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
    // this.load.image("foliage5", "assets/foliage10.png");
    this.load.image("player", "assets/player.png");
    this.load.image("death", "assets/death.png");
    this.load.audio("music", "assets/music.mp3");
    this.load.audio("wail1", "assets/wail1.mp3");
    this.load.audio("wail2", "assets/wail2.mp3");
  }

  create() {
    this.scene.start("StartScene");
  }
}
