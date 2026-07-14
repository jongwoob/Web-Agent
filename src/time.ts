export function nowMs(): number {
  return performance.now();
}

export function elapsedSince(startMs: number): number {
  return Math.round(performance.now() - startMs);
}
