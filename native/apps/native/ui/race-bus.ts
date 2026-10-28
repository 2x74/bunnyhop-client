import type { RaceRequest } from "../../web/src/player/race";
export type { RaceRequest };
const listeners = new Set<(request: RaceRequest) => void>();
let pending: RaceRequest | null = null;
export function requestRace(request: RaceRequest): void {
  if (!listeners.size) pending = request;
  else for (const listener of listeners) listener(request);
}
// Native playback chooses its map from the replay header; a web page reload is
// never needed to race a replay from a different map.
export const requestRaceAfterReload = requestRace;
export function onRaceRequest(listener: (request: RaceRequest) => void): () => void {
  listeners.add(listener);
  if (pending) {
    listener(pending);
    pending = null;
  }
  return () => {
    listeners.delete(listener);
  };
}
