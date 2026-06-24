// GameManager.ts — single source of truth for the game's tunable values.
// Every value here can be edited live via the config panel and is persisted.

export interface EditableParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  // "bool" renders a checkbox (0/1) instead of a number input.
  type?: "number" | "bool";
  // Heading the param is grouped under in the config panel.
  section: string;
}

// The size params an "Overall size" master governs. Editing any of them
// individually clears the master (see setParam).
const SCALE_DEPENDENTS = [
  "creatureSize",
  "hunterSize",
  "foliageSize",
  "gridSize",
];

export default class GameManager {
  private static instance: GameManager;

  private initialCreatures = 3; // day 1 starts with this many; later days carry survivors
  // Hunters spawned at the start of each day = huntersBase + huntersPerLevel*(day-1).
  private huntersBase = 1; // hunters on day 1 (the N in "N + per-day")
  private huntersPerLevel = 1; // extra hunters added each subsequent day
  private initialFoliage = 50;
  private regularLevelFoliage = 50;
  // Ongoing plant spawning during a level. Amount of 0 turns it off. While it
  // is on, the field never empties, so levels advance via the button.
  private foliageSpawnAmount = 1;
  private foliageSpawnRateMs = 800;
  private maxFoliage = 400; // cap so the field can't grow without bound
  private maxCreatures = 999; // cap on the flock so breeding can't tank the framerate
  // Optional master size: 0 = off; when > 0 it sets every entity/grid size to
  // base * scale. Editing any dependent size individually turns it off again.
  private overallScale = 0;
  // Heritable mutation on breeding (drifts speed + a colour gene).
  private mutationsEnabled = 1; // 0/1 toggle
  private mutationChance = 0.3; // chance a newborn mutates
  private mutationAmount = 0.25; // magnitude of the drift (fraction)
  // Speeds are pixels per second. Hunters are a touch faster than an unfed
  // creature, so a creature can't simply outrun one in a straight line: it has
  // to use its head start (fear radius) to reach a home, or eat to get quicker.
  private hunterSpeed = 150;
  private hunterSize = 42;
  private hunterFearRadius = 140;
  private creatureSpeed = 110;
  private creatureSize = 32;
  private creatureReproduceThreshold = 2;
  private creatureEatingDuration = 1000;
  // Each plant eaten adds this toward the creature's max speed.
  private creatureSpeedIncrement = 2;
  private creatureMaxSpeed = 200;
  private creatureReproduceRange: [number, number] = [0, 3];
  // A newborn hunter can't kill for this long after spawning.
  private hunterSpawnGraceMs = 700;
  private foliageSize = 32;
  private homeSize = 64;
  private gridSize = 32;
  private scoreTextFontSize = "24px";
  private deathSize = 22;
  private playerSize = 64;

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  public static getInstance(): GameManager {
    if (!GameManager.instance) {
      GameManager.instance = new GameManager();
      GameManager.instance.loadOverrides();
    }
    return GameManager.instance;
  }

  // The set of values the config panel can edit. get/set close over the private
  // fields, so the rest of the class keeps its typed getters.
  public getEditableParams(): EditableParam[] {
    const p = (
      section: string,
      key: string,
      label: string,
      min: number,
      max: number,
      step: number,
      get: () => number,
      set: (v: number) => void,
      type: "number" | "bool" = "number"
    ): EditableParam => ({ key, label, min, max, step, get, set, type, section });
    return [
      p("Population", "initialCreatures", "Creatures (day 1)", 1, 60, 1, () => this.initialCreatures, (v) => (this.initialCreatures = v)),
      p("Population", "huntersBase", "Hunters (day 1)", 0, 20, 1, () => this.huntersBase, (v) => (this.huntersBase = v)),
      p("Population", "huntersPerLevel", "Hunters added per day", 0, 20, 1, () => this.huntersPerLevel, (v) => (this.huntersPerLevel = v)),
      p("Population", "maxCreatures", "Max creatures (perf cap)", 20, 1000, 20, () => this.maxCreatures, (v) => (this.maxCreatures = v)),

      p("Plants", "initialFoliage", "Plants (day 1)", 0, 800, 10, () => this.initialFoliage, (v) => (this.initialFoliage = v)),
      p("Plants", "regularLevelFoliage", "Plants (later days)", 0, 800, 10, () => this.regularLevelFoliage, (v) => (this.regularLevelFoliage = v)),
      p("Plants", "foliageSpawnAmount", "Auto-spawn plants/tick (0=off)", 0, 50, 1, () => this.foliageSpawnAmount, (v) => (this.foliageSpawnAmount = v)),
      p("Plants", "foliageSpawnRateMs", "Auto-spawn interval (ms)", 100, 5000, 50, () => this.foliageSpawnRateMs, (v) => (this.foliageSpawnRateMs = v)),
      p("Plants", "maxFoliage", "Max plants on field", 50, 1500, 25, () => this.maxFoliage, (v) => (this.maxFoliage = v)),

      p("Creatures", "creatureSpeed", "Creature speed", 10, 400, 5, () => this.creatureSpeed, (v) => (this.creatureSpeed = v)),
      p("Creatures", "creatureMaxSpeed", "Creature max speed", 10, 500, 5, () => this.creatureMaxSpeed, (v) => (this.creatureMaxSpeed = v)),
      p("Creatures", "creatureSpeedIncrement", "Speed gained per plant", 0, 60, 1, () => this.creatureSpeedIncrement, (v) => (this.creatureSpeedIncrement = v)),
      p("Creatures", "creatureReproduceThreshold", "Plants eaten to breed", 1, 20, 1, () => this.creatureReproduceThreshold, (v) => (this.creatureReproduceThreshold = v)),
      p("Creatures", "reproduceMin", "Offspring min", 0, 8, 1, () => this.creatureReproduceRange[0], (v) => (this.creatureReproduceRange[0] = v)),
      p("Creatures", "reproduceMax", "Offspring max", 1, 8, 1, () => this.creatureReproduceRange[1], (v) => (this.creatureReproduceRange[1] = v)),
      p("Creatures", "creatureEatingDuration", "Eating time (ms)", 20, 2000, 20, () => this.creatureEatingDuration, (v) => (this.creatureEatingDuration = v)),

      p("Hunters", "hunterSpeed", "Hunter speed", 10, 400, 5, () => this.hunterSpeed, (v) => (this.hunterSpeed = v)),
      p("Hunters", "hunterFearRadius", "Fear radius", 20, 600, 10, () => this.hunterFearRadius, (v) => (this.hunterFearRadius = v)),
      p("Hunters", "hunterSpawnGraceMs", "Hunter spawn grace (ms)", 0, 3000, 50, () => this.hunterSpawnGraceMs, (v) => (this.hunterSpawnGraceMs = v)),

      p("Mutations", "mutationsEnabled", "Mutations on", 0, 1, 1, () => this.mutationsEnabled, (v) => (this.mutationsEnabled = v ? 1 : 0), "bool"),
      p("Mutations", "mutationChance", "Mutation chance (0-1)", 0, 1, 0.05, () => this.mutationChance, (v) => (this.mutationChance = v)),
      p("Mutations", "mutationAmount", "Mutation amount (0-1)", 0, 1, 0.05, () => this.mutationAmount, (v) => (this.mutationAmount = v)),

      p("Sizes & scale", "overallScale", "Overall size (0=off)", 0, 4, 0.1, () => this.overallScale, (v) => { this.overallScale = v; if (v > 0) this.applyOverallScale(v); }),
      p("Sizes & scale", "creatureSize", "Creature size", 8, 96, 2, () => this.creatureSize, (v) => (this.creatureSize = v)),
      p("Sizes & scale", "hunterSize", "Hunter size", 8, 96, 2, () => this.hunterSize, (v) => (this.hunterSize = v)),
      p("Sizes & scale", "foliageSize", "Plant size", 8, 96, 2, () => this.foliageSize, (v) => (this.foliageSize = v)),
      p("Sizes & scale", "homeSize", "Home size", 16, 200, 4, () => this.homeSize, (v) => (this.homeSize = v)),
      p("Sizes & scale", "gridSize", "Path grid size", 16, 96, 4, () => this.gridSize, (v) => (this.gridSize = v)),
    ];
  }

  // Set every entity/grid size from a single master scale (base size * scale).
  private applyOverallScale(scale: number): void {
    this.creatureSize = Math.round(32 * scale);
    this.hunterSize = Math.round(32 * scale);
    this.foliageSize = Math.round(32 * scale);
    this.gridSize = Math.max(16, Math.round(32 * scale));
  }

  public setParam(key: string, value: number): void {
    const param = this.getEditableParams().find((q) => q.key === key);
    if (!param) {
      return;
    }
    param.set(value);
    // Editing one of the governed sizes directly turns the master scale off, so
    // the manual value wins and isn't overwritten on the next reload.
    if (SCALE_DEPENDENTS.includes(key)) {
      this.overallScale = 0;
    }
    // Persist the full resolved snapshot (not just the edited key), so derived
    // values and the cleared master stay consistent on reload.
    try {
      const obj: Record<string, number> = {};
      for (const q of this.getEditableParams()) {
        obj[q.key] = q.get();
      }
      localStorage.setItem("chd-config", JSON.stringify(obj));
    } catch (e) {
      /* ignore */
    }
  }

  public resetParams(): void {
    try {
      localStorage.removeItem("chd-config");
    } catch (e) {
      /* ignore */
    }
    this.initialCreatures = 3;
    this.huntersBase = 1;
    this.huntersPerLevel = 1;
    this.initialFoliage = 50;
    this.regularLevelFoliage = 50;
    this.foliageSpawnAmount = 1;
    this.foliageSpawnRateMs = 800;
    this.maxFoliage = 400;
    this.maxCreatures = 999;
    this.hunterSpeed = 150;
    this.hunterSize = 42;
    this.hunterFearRadius = 140;
    this.creatureSpeed = 110;
    this.creatureSize = 32;
    this.creatureReproduceThreshold = 2;
    this.creatureEatingDuration = 1000;
    this.creatureSpeedIncrement = 2;
    this.creatureMaxSpeed = 200;
    this.creatureReproduceRange = [0, 3];
    this.hunterSpawnGraceMs = 700;
    this.foliageSize = 32;
    this.homeSize = 64;
    this.gridSize = 32;
    this.overallScale = 0;
    this.mutationsEnabled = 1;
    this.mutationChance = 0.3;
    this.mutationAmount = 0.25;
  }

  private loadOverrides(): void {
    try {
      const raw = localStorage.getItem("chd-config");
      if (!raw) {
        return;
      }
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const param of this.getEditableParams()) {
        if (typeof obj[param.key] === "number") {
          param.set(obj[param.key]);
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  public getInitialCreatures(): number {
    return this.initialCreatures;
  }
  public getHuntersBase(): number {
    return this.huntersBase;
  }
  public getHuntersPerLevel(): number {
    return this.huntersPerLevel;
  }
  // Hunters spawned at the start of a given day (1-based).
  public getHunterCountForLevel(level: number): number {
    return this.huntersBase + this.huntersPerLevel * Math.max(0, level - 1);
  }
  public getInitialFoliage(): number {
    return this.initialFoliage;
  }
  public getRegularLevelFoliage(): number {
    return this.regularLevelFoliage;
  }
  public getFoliageSpawnAmount(): number {
    return this.foliageSpawnAmount;
  }
  public getFoliageSpawnRateMs(): number {
    return this.foliageSpawnRateMs;
  }
  public getMaxFoliage(): number {
    return this.maxFoliage;
  }
  public getMaxCreatures(): number {
    return this.maxCreatures;
  }
  public getMutationsEnabled(): boolean {
    return this.mutationsEnabled !== 0;
  }
  public getMutationChance(): number {
    return this.mutationChance;
  }
  public getMutationAmount(): number {
    return this.mutationAmount;
  }
  public getHunterSpeed(): number {
    return this.hunterSpeed;
  }
  public getHunterSize(): number {
    return this.hunterSize;
  }
  public getHunterFearRadius(): number {
    return this.hunterFearRadius;
  }
  public getHunterSpawnGraceMs(): number {
    return this.hunterSpawnGraceMs;
  }
  public getCreatureSpeed(): number {
    return this.creatureSpeed;
  }
  public getCreatureSize(): number {
    return this.creatureSize;
  }
  public getCreatureReproduceThreshold(): number {
    return this.creatureReproduceThreshold;
  }
  public getCreatureSpeedIncrement(): number {
    return this.creatureSpeedIncrement;
  }
  public getCreatureMaxSpeed(): number {
    return this.creatureMaxSpeed;
  }
  public getCreatureReproduceRange(): [number, number] {
    return this.creatureReproduceRange;
  }
  public getCreatureEatingDuration(): number {
    return this.creatureEatingDuration;
  }
  public getFoliageSize(): number {
    return this.foliageSize;
  }
  public getHomeSize(): number {
    return this.homeSize;
  }
  public getGridSize(): number {
    return this.gridSize;
  }
  public getScoreTextFontSize(): string {
    return this.scoreTextFontSize;
  }
  public getDeathSize(): number {
    return this.deathSize;
  }
  public getPlayerSize(): number {
    return this.playerSize;
  }
}
