import Phaser from "phaser";
import { Foliage } from "./entities";
import GameManager from "./GameManager";
import * as EasyStar from "easystarjs";
import GameScene from "./GameScene";

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

  const easystar = new EasyStar.js();
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
export function getPathGrid(scene: GameScene, gridSize: number): number[][] {
  const gameWidth = scene.scale.width;
  const gameHeight = scene.scale.height;
  const gridWidth = Math.ceil(gameWidth / gridSize);
  const gridHeight = Math.ceil(gameHeight / gridSize);

  // Start empty, then mark each plant's cell blocked. This is O(plants) rather
  // than O(plants * cells), which matters a lot when the meadow is dense.
  const grid: number[][] = [];
  for (let y = 0; y < gridHeight; y++) {
    grid.push(new Array<number>(gridWidth).fill(0));
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
