import { api } from "../../web/src/api";
import { boardRunFor, playerRunOn, setCopyStartHandler } from "../../web/src/copy-start-request";
import { isStyleId, type StyleId } from "../../web/src/styles";
import { styleAt } from "../../web/src/net/protocol";
import type { NativeRoomService } from "./room-service";
import { base64Bytes } from "./base64";
import { ReplayCache } from "./replay-cache";
import type { MenuMessage } from "./bridge";

export interface CopyStartContext {
  map: string | null;
  style: StyleId;
  track: number;
  loading: boolean;
}
interface Dependencies {
  context(): CopyStartContext;
  room: NativeRoomService;
  send(message: MenuMessage): void;
  reply(text: string): void;
  replay?: (id: string) => Promise<Uint8Array>;
}

export class NativeCopyStart {
  private readonly replays: ReplayCache;
  private revision = 0;
  private intent = 0;
  private nextId = 0;
  private contextKey = "";
  private pending: { id: number; answer(text: string): void } | null = null;
  constructor(private deps: Dependencies) {
    this.replays = new ReplayCache(deps.replay ?? ((id) => api.replay(id)));
  }
  update(): void {
    const context = this.deps.context();
    const key = JSON.stringify([context.map, context.style, context.track, context.loading]);
    if (key !== this.contextKey) {
      this.contextKey = key;
      ++this.revision;
      this.pending = null;
    }
    setCopyStartHandler(
      context.map && !context.loading
        ? {
            map: context.map,
            copy: (id, who, reply) => void this.copy(id, who, reply),
          }
        : null,
    );
  }
  async command(arg: string, answer = this.deps.reply): Promise<void> {
    const context = this.deps.context();
    if (!context.map || context.loading) return answer("Load a map first.");
    const revision = this.revision,
      intent = ++this.intent;
    const board = await boardRunFor(context.map, context.track ? "autohop" : context.style, context.track, arg);
    if (revision !== this.revision || intent !== this.intent) return;
    if ("error" in board) return answer(board.error);
    await this.copy(board.entry.runId, board.who, answer, intent);
  }
  /** True means the room owns the request; ranks and non-room names fall back to the board. */
  roomCommand(arg: string, answer = this.deps.reply): boolean {
    const room = this.deps.room.view;
    const query = arg.trim().toLowerCase();
    if (!query) {
      this.deps.send({ type: "chatAction", action: "copyStartMenu" });
      return true;
    }
    if (/^#?\d+$/.test(query)) return false;
    const others = room.players.filter((p) => p.slot !== room.you);
    const exact = others.filter((p) => p.name.toLowerCase() === query);
    const prefix = others.filter((p) => p.name.toLowerCase().startsWith(query));
    const player = exact.length === 1 ? exact[0] : !exact.length && prefix.length === 1 ? prefix[0] : null;
    if (!player) return false;
    void this.player(player.slot, answer);
    return true;
  }
  async player(slot: number | null, answer = this.deps.reply): Promise<void> {
    if (slot === null) return this.command("", answer);
    const context = this.deps.context(),
      room = this.deps.room.view;
    const player = room.players.find((p) => p.slot === slot);
    if (!context.map || context.loading || !player) return;
    const id = player.id,
      intent = ++this.intent,
      revision = this.revision,
      generation = room.generation;
    const meta = room.metas[String(slot)];
    const theirs = styleAt(meta?.style ?? -1) ?? player.style;
    const pbs = Object.entries(player.pb ?? {})
      .sort((a, b) => a[1] - b[1])
      .map(([style]) => style)
      .filter(isStyleId);
    const styles = context.track ? ["autohop" as const] : [theirs, context.style, ...pbs].filter(isStyleId);
    try {
      const entry = await playerRunOn(context.map, context.track, id, styles);
      if (
        revision !== this.revision ||
        intent !== this.intent ||
        generation !== room.generation ||
        !room.players.some((p) => p.id === id && p.slot === slot)
      )
        return;
      if (!entry)
        return answer(`${player.name} has no time on ${context.track ? `Bonus ${context.track}` : "this map"} yet.`);
      await this.copy(entry.runId, player.name, answer, intent);
    } catch {
      answer("Couldn't load the leaderboard.");
    }
  }
  async copy(runId: string, who: string, answer = this.deps.reply, intent = ++this.intent): Promise<void> {
    const context = this.deps.context(),
      revision = this.revision;
    if (!context.map || context.loading) return answer("Load a map first.");
    const id = ++this.nextId;
    this.pending = { id, answer };
    try {
      const replay = await this.replays.get(runId);
      if (revision !== this.revision || intent !== this.intent || this.pending?.id !== id) return;
      this.deps.send({
        type: "copyStart",
        id,
        map: context.map,
        style: context.style,
        who: who.slice(0, 128),
        replayBase64: base64Bytes(replay),
      });
    } catch {
      if (revision === this.revision && this.pending?.id === id) {
        this.pending = null;
        answer("Couldn't download that run's replay.");
      }
    }
  }
  receive(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const result = value as { id?: unknown; text?: unknown };
    if (result.id !== this.pending?.id || typeof result.text !== "string") return;
    const pending = this.pending;
    this.pending = null;
    pending?.answer(result.text.slice(0, 512));
  }
}
