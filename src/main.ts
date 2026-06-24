import Phaser from "phaser";
import BootScene from "./scenes/BootScene";
import GameScene from "./scenes/GameScene";
import PreloadScene from "./scenes/PreloadScene";
import StartScene from "./scenes/StartScene";
import { setDebug, DEBUG } from "./scenes/debug";

// ?debug in the URL turns on physics body outlines + event logging.
setDebug(new URLSearchParams(location.search).has("debug"));

// A fixed LOW-resolution playfield, sized to the container's current aspect so
// FIT can scale it up to fill the screen with no letterbox bands. The short
// side is fixed (the "retro" pixel budget); the long side follows the aspect.
const SHORT_SIDE = 540;
function computeBase(): { width: number; height: number } {
  const el = document.getElementById("game-container");
  const w = Math.max(1, el ? el.clientWidth : window.innerWidth);
  const h = Math.max(1, el ? el.clientHeight : window.innerHeight);
  return w >= h
    ? { width: Math.round(SHORT_SIDE * (w / h)), height: SHORT_SIDE }
    : { width: SHORT_SIDE, height: Math.round(SHORT_SIDE * (h / w)) };
}
const base = computeBase();

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game-container",
  backgroundColor: "#243524",
  // Crisp pixels, no smoothing: the low-res world is upscaled blocky and retro.
  pixelArt: true,
  // FIT scales the fixed low-res base up to fill the container (re-fitting on
  // resize). The base matches the container's aspect, so it fills with no bands.
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: base.width,
    height: base.height,
  },
  scene: [BootScene, PreloadScene, StartScene, GameScene],
  physics: {
    default: "arcade",
    arcade: { debug: DEBUG },
  },
};

// Restart on a real viewmodel change — an orientation flip or a notable width
// change — by reloading, which recomputes the low-res base for the new shape so
// it always fills cleanly. Debounced; height-only changes (the mobile URL bar
// showing/hiding) are ignored so they don't trigger spurious reloads.
let lastWidth = window.innerWidth;
let lastPortrait = window.innerHeight > window.innerWidth;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
const onViewportChange = () => {
  const portrait = window.innerHeight > window.innerWidth;
  const width = window.innerWidth;
  if (portrait === lastPortrait && Math.abs(width - lastWidth) < 60) {
    return;
  }
  lastPortrait = portrait;
  lastWidth = width;
  window.clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => location.reload(), 300);
};
window.addEventListener("resize", onViewportChange);
window.addEventListener("orientationchange", onViewportChange);

// Wait for the blackletter display fonts to load before starting, so the canvas
// titles render in them instead of a fallback serif on first paint.
const startGame = () => new Phaser.Game(config);
const fonts = (document as { fonts?: { load(font: string): Promise<unknown> } })
  .fonts;
if (fonts) {
  Promise.all([
    fonts.load('1em "Olde English"'),
    fonts.load('700 1em "UnifrakturCook"'),
  ]).then(startGame, startGame);
} else {
  startGame();
}
