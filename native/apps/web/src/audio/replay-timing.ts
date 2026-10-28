/** Integer samples to visit, while timestamps retain the fractional clip origin. */
export function replayAudioTicks(from: number, to: number): { first: number; last: number } {
  return { first: Math.max(0, Math.floor(from) - 1), last: Math.floor(to) };
}
export function replayAudioWindTick(from: number, to: number, secondsSinceStart: number, tickrate: number): number {
  return Math.max(0, Math.min(Math.floor(to), Math.round(from + secondsSinceStart * tickrate)));
}
