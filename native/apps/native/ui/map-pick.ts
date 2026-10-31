// Play, a map tile, a link to a map: the one way a map is asked for. Whatever happens the player gets the map or a
// reason, and the log says which.
import { isMapName } from "./bridge";

export interface MapPickHost {
  /** The map that's up, if any. */
  map(): string | null;
  /** What's running for the map being left (the room, the attempt). Each part on its own: one throwing must not cost the pick. */
  leaving: readonly (() => void)[];
  /** Back to the map that's already up. */
  resume(): void;
  request(id: string): void;
  /** Says why it can't go ahead, to the player and the log. */
  refuse(text: string): void;
  /** A line for the log only. */
  log(text: string): void;
}

export function pickMap(id: string, host: MapPickHost): void {
  const shown = id.slice(0, 40);
  if (!isMapName(id)) {
    host.refuse(`Can't load "${shown}": that isn't a map name.`);
    return;
  }
  for (const step of host.leaving) {
    try {
      step();
    } catch (error) {
      host.log(`map pick ${id}: leaving the last map failed: ${String(error)}`);
    }
  }
  if (id === host.map()) host.resume();
  else host.request(id);
}
