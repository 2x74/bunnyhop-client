// One room connection: WebSocket lifecycle (reconnect with backoff), RTT probes, server clock offset, outgoing
// state batches and control messages. No DOM and no three.js; net/mp.ts wires it to the game.

import { api } from "../api";
import { MSG_VOICE_DOWN } from "./voice-wire";
import { noteDrop, noteReconnect } from "./room-health";
import {
  CLOSE,
  decodeSnapshot,
  encodeInput,
  encodeState,
  MAX_SAMPLES,
  parseServerMsg,
  PROTOCOL_VERSION,
  type ClientMsg,
  type GainLogReport,
  type NetInput,
  type NetMeta,
  type NetSample,
  type ServerMsg,
  type Snapshot,
} from "./protocol";

export type RoomStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface RoomHandlers {
  message(m: ServerMsg): void;
  snapshot(s: Snapshot, now: number): void;
  status(s: RoomStatus, detail?: string): void;
}

const PING_MS = 2000;
/**
 * Nothing from the room for this long while our own timers run on time (pings go out every PING_MS and the room's
 * runtime answers each at once): the connection is dead even if the browser hasn't noticed. A dead TCP path can take
 * the OS from ~20 s (Windows) to many minutes to report, while the room and everyone in it look frozen.
 */
export const SILENT_MS = 10_000;
/** Close codes after which reconnecting is pointless. */
const FINAL = new Set<number>([CLOSE.REPLACED, CLOSE.FULL, CLOSE.NO_MAPS, CLOSE.KICKED, CLOSE.BANNED, CLOSE.ABUSE, CLOSE.LEAVE, CLOSE.MAP_CHANGE, CLOSE.LOBBY_CLOSED]);

/**
 * How long to wait before connecting again after the `attempt`th drop in a row (0 = the first): a quarter second
 * first (most drops are blips, and the room holds the player's place for 20 s: apps/api rooms/room.ts
 * RESUME_GRACE_MS), then 1, 2, 4, 8 s up to 15 s, each with up to half again of jitter so a room that restarts isn't
 * hit by everyone at the same instant.
 */
export function retryDelay(attempt: number, rnd: () => number = Math.random): number {
  const base = attempt <= 0 ? 250 : Math.min(15_000, 1000 * 2 ** Math.min(4, attempt - 1));
  return Math.min(15_000, Math.round(base * (1 + rnd() * 0.5)));
}

export class RoomConnection {
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private pingSent = 0;
  private retry = 0;
  private stopped = false;
  /** performance.now() when the current socket opened (0: not open yet). */
  private openedAt = 0;
  /** The socket that's opening follows a drop (not the page's first connection). */
  private resuming = false;
  /** performance.now() of the last frame from the room, and of the last ping tick (staleness check). */
  private lastRx = 0;
  private lastTick = 0;
  private pending: NetSample[] = [];
  /** Smoothed round trip (ms). */
  rtt = 0;
  /** server time - local time (ms), from the welcome + RTT. */
  clockOffset = 0;
  status: RoomStatus = "connecting";
  /** Counters for the dev overlay / load test. */
  readonly stats = { sent: 0, sentBytes: 0, recv: 0, recvBytes: 0 };

  /** `socketUrl`, `timing`: where to connect and how often to ping / when to give up (tests); the defaults otherwise. */
  constructor(
    readonly id: string,
    private style: () => string,
    private h: RoomHandlers,
    private socketUrl: () => string = () => api.roomSocketUrl(id, PROTOCOL_VERSION, style()),
    private timing = { pingMs: PING_MS, silentMs: SILENT_MS },
  ) {
    this.open();
  }

  /** Server time now (ms). */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  /** Local Date.now() for a server timestamp. */
  toLocal(serverTime: number): number {
    return serverTime - this.clockOffset;
  }

  private setStatus(s: RoomStatus, detail?: string): void {
    this.status = s;
    this.h.status(s, detail);
  }

  private open(): void {
    let url: string;
    try {
      url = this.socketUrl();
    } catch {
      this.setStatus("closed", "Multiplayer needs the online API");
      return;
    }
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = this.lastRx = this.lastTick = performance.now();
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.tick(), this.timing.pingMs);
    };
    ws.onmessage = (e) => {
      const now = performance.now();
      this.lastRx = now;
      if (typeof e.data === "string") {
        this.stats.recv++;
        this.stats.recvBytes += e.data.length;
        if (e.data === "pong") return this.pong();
        const m = parseServerMsg(e.data);
        if (!m) return;
        if (m.t === "welcome") {
          // In: the backoff starts over (not on open: a room that accepts and drops at once is retried slowly).
          this.retry = 0;
          if (this.resuming) noteReconnect();
          this.resuming = false;
          this.clockOffset = m.now - (Date.now() - this.rtt / 2);
          this.setStatus("open");
        }
        this.h.message(m);
      } else {
        const buf = e.data as ArrayBuffer;
        this.stats.recv++;
        this.stats.recvBytes += buf.byteLength;
        // voice: VOICE_DOWN frames (net/voice-wire.ts) go to the voice client, never the snapshot decoders.
        if (buf.byteLength && new Uint8Array(buf, 0, 1)[0] === MSG_VOICE_DOWN) return void this.onVoice?.(buf);
        const s = decodeSnapshot(buf);
        if (s) this.h.snapshot(s, now);
      }
    };
    ws.onclose = (e) => this.closed(e.code, e.reason);
  }

  /** The socket is gone (closed, or given up on as stale): reconnect unless it was meant. */
  private closed(code: number, reason: string): void {
    clearInterval(this.pingTimer);
    this.ws = null;
    const age = this.openedAt ? performance.now() - this.openedAt : 0;
    this.openedAt = 0;
    if (this.stopped || FINAL.has(code)) {
      this.stopped = true;
      this.setStatus("closed", reason || undefined);
      return;
    }
    // Network blip / room restart: quickly at first, then backing off (retryDelay).
    noteDrop(code, reason, age);
    this.resuming = true;
    const wait = retryDelay(this.retry++);
    this.setStatus("reconnecting", wait < 1000 ? "Reconnecting…" : `Reconnecting in ${Math.round(wait / 1000)} s…`);
    setTimeout(() => !this.stopped && this.open(), wait);
  }

  /**
   * Every PING_MS: gives up on a socket the room has been silent on for SILENT_MS, else pings. Only when the timer ran
   * on time: a throttled (hidden) or stalled page can't tell silence from its own lateness, and its messages may still
   * be queued behind this tick.
   */
  private tick(): void {
    const now = performance.now();
    const onTime = now - this.lastTick < this.timing.pingMs * 2;
    this.lastTick = now;
    const ws = this.ws;
    if (onTime && ws && ws.readyState === WebSocket.OPEN && now - this.lastRx > this.timing.silentMs) {
      // Don't wait for a close handshake a dead path can't finish: let it go and connect again now. (The close frame
      // says STALE in case it does arrive: the room holds the place, and the new socket takes it over.)
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        ws.close(CLOSE.STALE, "stale");
      } catch {
        /* already closing */
      }
      return this.closed(CLOSE.STALE, "no answer from the room");
    }
    this.ping();
  }

  private ping(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.pingSent = performance.now();
    this.ws.send("ping"); // answered by the runtime's auto-response: never wakes the room
  }

  private pong(): void {
    if (!this.pingSent) return;
    const rtt = performance.now() - this.pingSent;
    this.pingSent = 0;
    this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
  }

  get open_(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.status === "open";
  }

  send(m: ClientMsg): void {
    if (!this.open_) return;
    const text = JSON.stringify(m);
    this.ws!.send(text);
    this.stats.sent++;
    this.stats.sentBytes += text.length;
  }

  /** voice: VOICE_DOWN frames from the room (voice/client.ts sets it). */
  onVoice: ((buf: ArrayBuffer) => void) | null = null;

  /** voice: one binary frame as is (VOICE_UP); false when the socket isn't open. */
  sendBinary(bytes: Uint8Array<ArrayBuffer>): boolean {
    if (!this.open_) return false;
    this.ws!.send(bytes);
    this.stats.sent++;
    this.stats.sentBytes += bytes.byteLength;
    return true;
  }

  /** Queues one 20 Hz sample; flushSamples() sends the batch (every SEND_TICKS). */
  pushSample(s: NetSample): void {
    this.pending.push(s);
    if (this.pending.length > MAX_SAMPLES) this.pending.shift();
  }

  /**
   * `weapon`: the weapon id in hand (core.ts WEAPON_IDS), null = not reported; `input`: for a room that takes it; `log`:
   * a gain log, for a room that relays them (0.0.43).
   */
  flushSamples(meta: Omit<NetMeta, "ping">, weapon: number | null = null, silenced = false, input: NetInput | null = null, log: GainLogReport | null = null): void {
    if (!this.pending.length) return;
    const samples = this.pending;
    this.pending = [];
    if (!this.open_) return;
    const bytes = encodeState({ ...meta, ping: Math.round(this.rtt) }, samples, weapon, silenced, input && encodeInput(input), log);
    this.ws!.send(bytes);
    this.stats.sent++;
    this.stats.sentBytes += bytes.length;
  }

  /** Leave for good (code 4000), or for a map change (4001: no leave message, the next page reconnects). */
  close(code: number = CLOSE.LEAVE): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    try {
      this.ws?.close(code, code === CLOSE.MAP_CHANGE ? "map change" : "leave");
    } catch {
      /* already closed */
    }
    this.ws = null;
  }
}
