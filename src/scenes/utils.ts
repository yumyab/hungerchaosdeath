import Phaser from "phaser";
import { Foliage } from "./entities";
import GameManager from "./GameManager";
import * as EasyStar from "easystarjs";
import GameScene from "./GameScene";

// One reused easystar solver (see findPath); paths compute synchronously so a
// single shared instance is safe.
let sharedEasyStar: EasyStar.js | undefined;

export function getRandomSpawnPoint(
  scene: Phaser.Scene,
  isEdge = false
): { x: number; y: number } {
  const gameWidth = scene.scale.width;
  const gameHeight = scene.scale.height;
  const padding = 50;

  let x = 0;
  let y = 0;
  if (isEdge) {
    const edge = Phaser.Math.Between(0, 3);
    switch (edge) {
      case 0:
        x = Phaser.Math.Between(padding, gameWidth - padding);
        y = padding;
        break;
      case 1:
        x = gameWidth - padding;
        y = Phaser.Math.Between(padding, gameHeight - padding);
        break;
      case 2:
        x = Phaser.Math.Between(padding, gameWidth - padding);
        y = gameHeight - padding;
        break;
      case 3:
        x = padding;
        y = Phaser.Math.Between(padding, gameHeight - padding);
        break;
    }
  } else {
    x = Phaser.Math.Between(padding, gameWidth - padding);
    y = Phaser.Math.Between(padding, gameHeight - padding);
  }
  return { x, y };
}

export function getNearestEntity<T extends Phaser.GameObjects.Sprite>(
  entities: Phaser.GameObjects.Group,
  source: Phaser.GameObjects.Sprite,
  accept?: (entity: T) => boolean
): T | undefined {
  let nearestEntity: T | undefined;
  let minDistance = Infinity;

  const entitiesArray = entities.getChildren() as T[];
  for (const entity of entitiesArray) {
    if (accept && !accept(entity)) {
      continue;
    }
    const distance = Phaser.Math.Distance.Between(
      source.x,
      source.y,
      entity.x,
      entity.y
    );
    if (distance < minDistance) {
      minDistance = distance;
      nearestEntity = entity;
    }
  }

  return nearestEntity;
}

// Walk the grid cells along the straight line from (x0,y0) to (x1,y1) and report
// whether any are blocked. Used to skip A* entirely when there's a clear shot to
// the goal (the common case in open field), which removes most pathfinding work.
export function lineBlocked(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  grid: number[][],
  gridSize: number
): boolean {
  if (grid.length === 0) {
    return false;
  }
  const h = grid.length;
  const w = grid[0].length;
  let cx = Math.floor(x0 / gridSize);
  let cy = Math.floor(y0 / gridSize);
  const ex = Math.floor(x1 / gridSize);
  const ey = Math.floor(y1 / gridSize);
  const dx = Math.abs(ex - cx);
  const dy = Math.abs(ey - cy);
  const sx = cx < ex ? 1 : -1;
  const sy = cy < ey ? 1 : -1;
  let err = dx - dy;
  // Bounded walk; the grid is small so this is a handful of cells per call.
  for (let guard = 0; guard < w + h + 4; guard++) {
    if (cy >= 0 && cy < h && cx >= 0 && cx < w && grid[cy][cx] === 1) {
      return true;
    }
    if (cx === ex && cy === ey) {
      return false;
    }
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
  return false;
}

export function findPath(
  scene: GameScene,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  grid: number[][],
  callback: (path: { x: number; y: number }[]) => void
): void {
  const gridSize = GameManager.getInstance().getGridSize();
  const gridWidth = grid[0].length;
  const gridHeight = grid.length;

  let validStartX = startX;
  let validStartY = startY;
  let validEndX = endX;
  let validEndY = endY;

  // Find the nearest valid start position within the game world
  const startGridX = Math.floor(startX / gridSize);
  const startGridY = Math.floor(startY / gridSize);
  if (
    startGridX < 0 ||
    startGridX >= gridWidth ||
    startGridY < 0 ||
    startGridY >= gridHeight ||
    grid[startGridY][startGridX] === 1
  ) {
    const nearestValidStart = findNearestValidPosition(
      scene,
      startX,
      startY,
      grid,
      gridSize
    );
    if (nearestValidStart) {
      validStartX = nearestValidStart.x;
      validStartY = nearestValidStart.y;
    } else {
      console.warn("No valid start position found for pathfinding");
      callback([]);
      return;
    }
  }

  // Find the nearest valid end position within the game world
  const endGridX = Math.floor(endX / gridSize);
  const endGridY = Math.floor(endY / gridSize);
  if (
    endGridX < 0 ||
    endGridX >= gridWidth ||
    endGridY < 0 ||
    endGridY >= gridHeight ||
    grid[endGridY][endGridX] === 1
  ) {
    const nearestValidEnd = findNearestValidPosition(
      scene,
      endX,
      endY,
      grid,
      gridSize
    );
    if (nearestValidEnd) {
      validEndX = nearestValidEnd.x;
      validEndY = nearestValidEnd.y;
    } else {
      console.warn("No valid end position found for pathfinding");
      callback([]);
      return;
    }
  }

  // Reuse one easystar instance across calls (each path computes synchronously
  // below), so we don't allocate a solver per repath.
  const easystar = sharedEasyStar ?? (sharedEasyStar = new EasyStar.js());
  easystar.setGrid(grid);
  easystar.setAcceptableTiles([0]);
  easystar.findPath(
    Math.floor(validStartX / gridSize),
    Math.floor(validStartY / gridSize),
    Math.floor(validEndX / gridSize),
    Math.floor(validEndY / gridSize),
    (path) => {
      if (path === null) {
        callback([]);
      } else {
        const smoothedPath = smoothPath(
          path.map((point) => ({
            x: point.x * gridSize + gridSize / 2,
            y: point.y * gridSize + gridSize / 2,
          }))
        );
        callback(smoothedPath);
      }
    }
  );
  easystar.calculate();
}
function findNearestValidPosition(
  scene: GameScene,
  x: number,
  y: number,
  grid: number[][],
  gridSize: number
): { x: number; y: number } | null {
  const gameWidth = scene.scale.width;
  const gameHeight = scene.scale.height;
  const padding = 50;

  const startGridX = Math.floor(x / gridSize);
  const startGridY = Math.floor(y / gridSize);

  for (let radius = 1; radius <= Math.max(gameWidth, gameHeight); radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const newX = startGridX + dx;
        const newY = startGridY + dy;

        if (
          newX >= 0 &&
          newX < grid[0].length &&
          newY >= 0 &&
          newY < grid.length &&
          grid[newY][newX] === 0
        ) {
          const validX = newX * gridSize + gridSize / 2;
          const validY = newY * gridSize + gridSize / 2;

          if (
            validX >= padding &&
            validX <= gameWidth - padding &&
            validY >= padding &&
            validY <= gameHeight - padding
          ) {
            return { x: validX, y: validY };
          }
        }
      }
    }
  }

  return null;
}

function smoothPath(
  path: { x: number; y: number }[]
): { x: number; y: number }[] {
  const smoothedPath: { x: number; y: number }[] = [];

  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    smoothedPath.push(point);

    if (i < path.length - 1) {
      const nextPoint = path[i + 1];
      const dx = nextPoint.x - point.x;
      const dy = nextPoint.y - point.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > GameManager.getInstance().getGridSize()) {
        const numIntermediatePoints = Math.floor(
          distance / GameManager.getInstance().getGridSize()
        );

        for (let j = 1; j < numIntermediatePoints; j++) {
          const t = j / numIntermediatePoints;
          const intermediateX = point.x + dx * t;
          const intermediateY = point.y + dy * t;
          smoothedPath.push({ x: intermediateX, y: intermediateY });
        }
      }
    }
  }

  return smoothedPath;
}
export function getPathGrid(
  scene: GameScene,
  gridSize: number,
  reuse?: number[][]
): number[][] {
  const gameWidth = scene.scale.width;
  const gameHeight = scene.scale.height;
  const gridWidth = Math.ceil(gameWidth / gridSize);
  const gridHeight = Math.ceil(gameHeight / gridSize);

  // Reuse the previous frame's grid array when the dimensions match (they only
  // change on resize, which reloads the scene), clearing it instead of
  // allocating a fresh 2D array every rebuild. Then mark each plant's cell
  // blocked — O(plants), not O(plants * cells).
  let grid: number[][];
  if (
    reuse &&
    reuse.length === gridHeight &&
    reuse[0] &&
    reuse[0].length === gridWidth
  ) {
    grid = reuse;
    for (let y = 0; y < gridHeight; y++) {
      grid[y].fill(0);
    }
  } else {
    grid = [];
    for (let y = 0; y < gridHeight; y++) {
      grid.push(new Array<number>(gridWidth).fill(0));
    }
  }

  const foliageArray = scene.foliage.getChildren() as Foliage[];
  for (const foliageItem of foliageArray) {
    if (!foliageItem.active) {
      continue;
    }
    const cx = Math.floor(foliageItem.x / gridSize);
    const cy = Math.floor(foliageItem.y / gridSize);
    if (cx >= 0 && cx < gridWidth && cy >= 0 && cy < gridHeight) {
      grid[cy][cx] = 1;
    }
  }

  // The skull is a large obstacle: everything paths around it (a wide no-go
  // ring), so it can be used to herd or wall off the creatures and hunters.
  const scare = scene.skullScare();
  if (scare) {
    const cells = Math.ceil(scare.r / gridSize);
    const scx = Math.floor(scare.x / gridSize);
    const scy = Math.floor(scare.y / gridSize);
    for (let dy = -cells; dy <= cells; dy++) {
      for (let dx = -cells; dx <= cells; dx++) {
        if (dx * dx + dy * dy > cells * cells) {
          continue; // round footprint
        }
        const gx = scx + dx;
        const gy = scy + dy;
        if (gx >= 0 && gx < gridWidth && gy >= 0 && gy < gridHeight) {
          grid[gy][gx] = 1;
        }
      }
    }
  }

  return grid;
}
