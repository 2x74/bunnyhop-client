// One room connection: WebSocket lifecycle (reconnect with backoff), RTT probes, server clock offset, outgoing
// state batches and control messages. No DOM and no three.js; net/mp.ts wires it to the game.

import { api } from "../api";
import {
  CLOSE,
  decodeSnapshot,
  encodeState,
  MAX_SAMPLES,
  parseServerMsg,
  PROTOCOL_VERSION,
  type ClientMsg,
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
/** Close codes after which reconnecting is pointless. */
const FINAL = new Set<number>([CLOSE.REPLACED, CLOSE.FULL, CLOSE.NO_MAPS, CLOSE.KICKED, CLOSE.BANNED, CLOSE.ABUSE, CLOSE.LEAVE, CLOSE.MAP_CHANGE, CLOSE.LOBBY_CLOSED]);

export class RoomConnection {
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private pingSent = 0;
  private retry = 0;
  private stopped = false;
  private pending: NetSample[] = [];
  /** Smoothed round trip (ms). */
  rtt = 0;
  /** server time - local time (ms), from the welcome + RTT. */
  clockOffset = 0;
  status: RoomStatus = "connecting";
  /** Counters for the dev overlay / load test. */
  readonly stats = { sent: 0, sentBytes: 0, recv: 0, recvBytes: 0 };

  constructor(
    readonly id: string,
    private style: () => string,
    private h: RoomHandlers,
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
      url = api.roomSocketUrl(this.id, PROTOCOL_VERSION, this.style());
    } catch {
      this.setStatus("closed", "Multiplayer needs the online API");
      return;
    }
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (e) => {
      const now = performance.now();
      if (typeof e.data === "string") {
        this.stats.recv++;
        this.stats.recvBytes += e.data.length;
        if (e.data === "pong") return this.pong();
        const m = parseServerMsg(e.data);
        if (!m) return;
        if (m.t === "welcome") {
          this.clockOffset = m.now - (Date.now() - this.rtt / 2);
          this.setStatus("open");
        }
        this.h.message(m);
      } else {
        const buf = e.data as ArrayBuffer;
        this.stats.recv++;
        this.stats.recvBytes += buf.byteLength;
        const s = decodeSnapshot(buf);
        if (s) this.h.snapshot(s, now);
      }
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      this.ws = null;
      if (this.stopped || FINAL.has(e.code)) {
        this.stopped = true;
        this.setStatus("closed", e.reason || undefined);
        return;
      }
      // Network blip / room restart: back off 1, 2, 4 ... 15 s.
      const wait = Math.min(15_000, 1000 * 2 ** Math.min(4, this.retry++));
      this.setStatus("reconnecting", `Reconnecting in ${Math.round(wait / 1000)} s…`);
      setTimeout(() => !this.stopped && this.open(), wait);
    };
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

  /** Queues one 20 Hz sample; flushSamples() sends the batch (every SEND_TICKS). */
  pushSample(s: NetSample): void {
    this.pending.push(s);
    if (this.pending.length > MAX_SAMPLES) this.pending.shift();
  }

  /** `weapon`: the weapon id in hand (core.ts WEAPON_IDS), null = not reported. */
  flushSamples(meta: Omit<NetMeta, "ping">, weapon: number | null = null, silenced = false): void {
    if (!this.pending.length) return;
    const samples = this.pending;
    this.pending = [];
    if (!this.open_) return;
    const bytes = encodeState({ ...meta, ping: Math.round(this.rtt) }, samples, weapon, silenced);
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
