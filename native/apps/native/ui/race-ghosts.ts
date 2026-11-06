import type { Prefs } from "../../web/src/ui/settings";
import type { NativeGhost, NativeReplay } from "./bridge";

type Source = "pb" | "wr";
export interface RaceGhostContext {
  map: string;
  style: string;
  track: number;
  generation: number;
}
export interface RaceGhostRequest extends RaceGhostContext {
  type: "raceGhost";
  source: Source;
  ghostSlot: number;
  id?: string;
  replayBase64?: string;
}
interface Dependencies {
  pb: (context: RaceGhostContext) => Promise<Uint8Array | null>;
  wr: (context: RaceGhostContext) => Promise<Uint8Array | null>;
  base64: (bytes: Uint8Array) => string;
  send: (request: RaceGhostRequest) => void;
}

/** Race ghosts load independently of the pause screen and never restart the live run. */
export class NativeRaceGhosts {
  private key = "";
  private revision = 0;
  private attempted = new Set<Source>();
  private reserved = new Set<number>();
  constructor(private deps: Dependencies) {}

  refresh(): void {
    this.key = "";
  }

  update(
    context: RaceGhostContext | null,
    prefs: Prefs,
    ghosts: readonly NativeGhost[],
    replays: readonly NativeReplay[],
  ): void {
    const enabled = context && prefs.showGhost ? (["pb", "wr"] as const).filter((kind) => prefs.ghost[kind]) : [];
    const key = JSON.stringify([context, enabled]);
    if (key !== this.key) {
      this.key = key;
      ++this.revision;
      this.attempted.clear();
      this.reserved.clear();
    }
    if (!context) return;
    for (const source of enabled) {
      const loaded = ghosts.find((ghost) => ghost.source === source);
      if (
        this.attempted.has(source) ||
        (loaded && loaded.map === context.map && loaded.style === context.style && loaded.track === context.track)
      )
        continue;
      const slot =
        loaded?.slot ??
        [0, 1, 2, 3].find((index) => !this.reserved.has(index) && !ghosts.some((g) => g.slot === index));
      if (slot === undefined) continue;
      this.attempted.add(source);
      this.reserved.add(slot);
      const revision = this.revision;
      const local =
        source === "pb"
          ? replays
              .filter(
                (run) =>
                  run.localSummary?.eligible === true &&
                  run.map === context.map &&
                  run.style === context.style &&
                  run.track === context.track &&
                  run.seconds > 0,
              )
              .sort((a, b) => a.seconds - b.seconds)[0]
          : undefined;
      void this.deps[source](context)
        .then((bytes) => {
          if (revision !== this.revision) return;
          const request = { type: "raceGhost" as const, ...context, source, ghostSlot: slot };
          if (bytes?.length) this.deps.send({ ...request, replayBase64: this.deps.base64(bytes) });
          else if (local) this.deps.send({ ...request, id: local.id });
        })
        .catch(() => {
          if (revision === this.revision && local)
            this.deps.send({ type: "raceGhost", ...context, source, ghostSlot: slot, id: local.id });
        });
    }
  }
}
