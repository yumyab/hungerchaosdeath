// Lightweight debug instrumentation, enabled with ?debug in the URL.
// Off by default, so it is inert in a normal build.
export let DEBUG = false;

export function setDebug(value: boolean): void {
  DEBUG = value;
}

const events: Record<string, unknown>[] = [];

export function dlog(type: string, data: Record<string, unknown> = {}): void {
  if (!DEBUG) {
    return;
  }
  const entry = { t: Math.round(performance.now()), type, ...data };
  events.push(entry);
  console.log(`[CHD] ${JSON.stringify(entry)}`);
}

export function getEvents(): Record<string, unknown>[] {
  return events;
}
