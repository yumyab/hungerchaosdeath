import Phaser from "phaser";

// A uniform spatial hash for fast nearest-neighbour queries. Rebuilt each frame
// from a group's children; `nearest` expands outward ring by ring from the
// query cell so it only ever looks at nearby buckets instead of scanning every
// entity. This turns the O(N) nearest-entity scans (run for every creature and
// hunter, several times a second) into roughly O(1), which is what lets the
// population climb into the thousands without the per-frame cost exploding.
export class SpatialHash<T extends Phaser.GameObjects.Sprite> {
  private readonly cell: number;
  private readonly buckets = new Map<number, T[]>();

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(cx: number, cy: number): number {
    // cx can be negative; offset keeps the key unique and collision-free for any
    // realistic field size (< ~100k cells across).
    return (cy + 50000) * 100003 + (cx + 50000);
  }

  build(items: T[]): void {
    this.buckets.clear();
    const c = this.cell;
    for (const it of items) {
      if (!it.active) {
        continue;
      }
      const k = this.key(Math.floor(it.x / c), Math.floor(it.y / c));
      const b = this.buckets.get(k);
      if (b) {
        b.push(it);
      } else {
        this.buckets.set(k, [it]);
      }
    }
  }

  // Call cb for every active item within `radius` of (x,y). Only scans the cells
  // the radius overlaps, so it stays cheap regardless of total population.
  forEachNear(
    x: number,
    y: number,
    radius: number,
    cb: (e: T) => void
  ): void {
    const c = this.cell;
    const r = Math.ceil(radius / c);
    const cx = Math.floor(x / c);
    const cy = Math.floor(y / c);
    const r2 = radius * radius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const b = this.buckets.get(this.key(cx + dx, cy + dy));
        if (!b) {
          continue;
        }
        for (const it of b) {
          if (!it.active) {
            continue;
          }
          const ex = it.x - x;
          const ey = it.y - y;
          if (ex * ex + ey * ey <= r2) {
            cb(it);
          }
        }
      }
    }
  }

  // Nearest accepted item to (x,y), or undefined. Searches rings outward and,
  // once a candidate is found, checks one extra ring so a closer entity in an
  // adjacent cell isn't missed (exact enough for AI targeting).
  nearest(x: number, y: number, accept?: (e: T) => boolean): T | undefined {
    const c = this.cell;
    const cx = Math.floor(x / c);
    const cy = Math.floor(y / c);
    let best: T | undefined;
    let bestD = Infinity;
    let foundRing = -1;
    const maxR = 80; // hard stop so a near-empty field can't spin

    for (let r = 0; r <= maxR; r++) {
      if (foundRing >= 0 && r > foundRing + 1) {
        break;
      }
      for (let dy = -r; dy <= r; dy++) {
        const ay = Math.abs(dy);
        for (let dx = -r; dx <= r; dx++) {
          // Border cells of the ring only (skip the interior already scanned).
          if (ay !== r && Math.abs(dx) !== r) {
            continue;
          }
          const b = this.buckets.get(this.key(cx + dx, cy + dy));
          if (!b) {
            continue;
          }
          for (const it of b) {
            if (accept && !accept(it)) {
              continue;
            }
            const ddx = it.x - x;
            const ddy = it.y - y;
            const d = ddx * ddx + ddy * ddy;
            if (d < bestD) {
              bestD = d;
              best = it;
            }
          }
        }
      }
      if (best && foundRing < 0) {
        foundRing = r;
      }
    }
    return best;
  }
}
