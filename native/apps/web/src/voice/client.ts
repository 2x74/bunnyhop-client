// Voice chat in rooms: push to talk (X by default, Prefs.voice.key; console `bind x +voicerecord`), everyone in the
// room hears everyone (alltalk; the room routes, apps/api src/rooms/voice.ts). One controller for the page; net/mp.ts
// attaches it to each room connection, the scoreboards and name tags ask it who's talking.
//
// Talking: the first press asks for the microphone (never before: joining a room asks nothing). Held: 20 ms frames go
// through the Opus encoder (voice/codec.ts) and leave in packets of two (VOICE_UP, net/voice-wire.ts). Let go: the
// microphone keeps sending for RELEASE_TAIL_MS so the last syllable isn't cut, then the spurt ends (VF_END). Guests
// can't talk: the key shows one plain line instead. A room mute (staff, a lobby's host) does the same.
// Listening: VOICE_DOWN frames are decoded and played through a small adaptive jitter buffer (voice/playback.ts) into
// the game's audio graph: talker gain (your mute / volume for them, voice/people.ts) -> voice bus (voice_scale) ->
// master. Nothing is recorded or kept.

import { mouseCode } from "../binds";
import { prefs } from "../ui/settings";
import { keyLabel } from "../ui/settings";
import type { RoomConnection } from "../net/room";
import type { RoomInfo } from "../net/protocol";
import { decodeVoiceDown, encodeVoiceUp, VF_END, VF_START, VOICE_FRAMES_PER_PACKET } from "../net/voice-wire";
import { createEncoder, levelOf, type VoiceEncoder } from "./codec";
import type { MicCapture, MicProblem } from "./capture";
import { TalkerPlayback } from "./playback";
import { voicePeople } from "./people";
import { VoiceHud, type TalkerLook, type TalkerView } from "./hud";
import { bandsOf } from "./spectrum";

/** After the key comes up the microphone keeps going this long (the end of the last word). */
export const RELEASE_TAIL_MS = 220;
/** One spurt at most this long (the room's cap is a little longer); then let go and press again. */
export const CLIENT_SPURT_MS = 59_000;
/** A talker with no packet for this long has stopped (their VF_END got refused or they left). */
const SILENT_MS = 600;
/** HUD refresh. */
const TICK_MS = 100;
/** audio/engine.ts sliderGain (the same curve as every volume slider). Not imported: voice loads the engine lazily. */
const sliderGain = (v: number) => (v <= 0 ? 0 : Math.pow(Math.min(1, v), 1.7));
type Engine = typeof import("../audio").engine;

export interface VoicePerson {
  slot: number;
  id?: string;
  name: string;
  color: string;
  avatarUrl?: string | null;
  guest: boolean;
  /** Muted from voice in this room (roster voiceMuted). */
  roomMuted?: boolean;
  /** Their roster looks (the talker row of a supporter takes their card). */
  look?: TalkerLook;
}

export interface VoiceHost {
  you(): number | null;
  person(slot: number): VoicePerson | null;
  /** You may mute others for the room: staff with the mute permission, or the lobby's host. */
  canRoomMute(): boolean;
  /** The game has the keyboard (playing or spectating, no menu, no text field). */
  playing(): boolean;
  /** Where the talker list goes (#hud). */
  hudParent(): HTMLElement;
  /** Who's talking changed (the open scoreboard re-renders, name tags update). */
  changed?(): void;
}

type Self = null | "guest" | "muted" | "blocked" | "missing" | "unsupported" | "failed" | "limit";
const SELF_LINES: Record<Exclude<Self, null>, string> = {
  guest: "You need an account to talk.",
  muted: "You're muted from voice in this room.",
  blocked: "The microphone is blocked for this site.",
  missing: "No microphone found.",
  unsupported: "This browser can't use a microphone here.",
  failed: "The microphone didn't start.",
  limit: "One minute at a time. Press again to keep talking.",
};

export class VoiceController {
  /**
   * The game's audio engine, loaded on attach (a static import would pull the audio assets into everything that shows
   * a scoreboard, tests included).
   */
  private engine: Engine | null = null;
  private room: RoomConnection | null = null;
  private host: VoiceHost | null = null;
  /** The room relays voice (welcome room.voice). */
  active = false;
  hud: VoiceHud | null = null;
  private talkers = new Map<number, TalkerPlayback & { since?: number }>();
  private bus: GainNode | null = null;
  private busCtx: AudioContext | null = null;
  private mic: MicCapture | null = null;
  private micOpening: Promise<MicCapture | null> | null = null;
  private enc: VoiceEncoder | null = null;
  private held = false;
  /** A spurt is open (frames are going out, the release tail included). */
  transmitting = false;
  private tailTimer = 0;
  private seq = 0;
  private frames: Uint8Array[] = [];
  private startFlag = false;
  private spurtAt = 0;
  private myLevel = 0;
  /** Your latest microphone frame while you transmit (your row's bands). */
  private myPcm: Float32Array | null = null;
  private myBands: { pcm: Float32Array; out: Float32Array } | null = null;
  private tick = 0;
  private lineTimer = 0;
  private talkingKey = "";
  private unwatch: (() => void) | null = null;
  private meters = new Set<(level: number) => void>();
  /** Dev only (tools/voice/voice-proof.ts): every decoded frame per talker slot. */
  tap: ((slot: number, pcm: Float32Array) => void) | null = null;
  /** Counters (the local proof's report, the dev overlay). */
  readonly stats = { sentPackets: 0, sentFrames: 0, sentBytes: 0, recvPackets: 0, recvFrames: 0 };

  constructor() {
    if (typeof document === "undefined") return;
    const down = (code: string, e: Event, repeat: boolean) => {
      if (repeat || !this.wantsKey(code) || !this.host?.playing()) return;
      e.preventDefault();
      this.press();
    };
    const up = (code: string) => {
      if (this.held && code === prefs.get().voice.key) this.release();
    };
    document.addEventListener("keydown", (e) => down(e.code, e, e.repeat), true);
    document.addEventListener("keyup", (e) => up(e.code), true);
    document.addEventListener("mousedown", (e) => down(mouseCode(e.button), e, false), true);
    document.addEventListener("mouseup", (e) => up(mouseCode(e.button)), true);
    addEventListener("blur", () => this.held && this.release());
  }

  // ------------------------------------------------------------------ room lifecycle

  /** A room connection opened (net/mp.ts). The welcome says whether it relays voice. */
  attach(room: RoomConnection, host: VoiceHost): void {
    this.detach();
    this.room = room;
    this.host = host;
    void import("../audio").then((m) => (this.engine = m.engine), () => undefined);
    room.onVoice = (buf) => this.receive(buf);
    this.hud = new VoiceHud(host.hudParent());
    this.hud.onRowClick = (v, el) => void import("./menu").then((m) => m.openVoiceMenu(el, v.slot));
    this.unwatch = prefs.watch(() => this.applyPrefs());
    this.tick = window.setInterval(() => this.refresh(), TICK_MS);
  }

  /** Every welcome (a reconnect, a map change): voice on or off for this room, and tell it whether we listen. */
  welcome(info: Pick<RoomInfo, "voice">): void {
    this.active = !!info.voice;
    this.sendListen();
  }

  detach(): void {
    if (this.room) this.room.onVoice = null;
    this.stopSpurt(true);
    for (const t of this.talkers.values()) t.close();
    this.talkers.clear();
    this.hud?.dispose();
    this.hud = null;
    clearInterval(this.tick);
    this.unwatch?.();
    this.unwatch = null;
    this.room = null;
    this.host = null;
    this.active = false;
    if (!this.meters.size) this.closeMic();
  }

  /** Input.ownsKey (main.ts): in a voice room the push to talk key is voice's, not the bind it shares (solo: cp_tele). */
  ownsKey(code: string): boolean {
    return this.wantsKey(code);
  }

  private wantsKey(code: string): boolean {
    const p = prefs.get().voice;
    return this.active && !!this.room && p.enabled && !!p.key && code === p.key;
  }

  private lastListen: boolean | null = null;
  private sendListen(): void {
    if (!this.room || !this.active) return;
    const on = prefs.get().voice.enabled;
    this.lastListen = on;
    this.room.send({ t: "voice", listen: on });
  }

  private applyPrefs(): void {
    const p = prefs.get().voice;
    if (this.bus && this.busCtx) this.bus.gain.setTargetAtTime(sliderGain(p.volume), this.busCtx.currentTime, 0.03);
    if (this.lastListen !== p.enabled) {
      this.sendListen();
      if (!p.enabled) {
        this.stopSpurt(true);
        for (const t of this.talkers.values()) t.close();
        this.talkers.clear();
      }
    }
    if (this.mic && p.device && this.mic.deviceId !== p.device && !this.transmitting) this.closeMic();
  }

  // ------------------------------------------------------------------ talking

  private me(): VoicePerson | null {
    const s = this.host?.you();
    return s === null || s === undefined ? null : (this.host?.person(s) ?? null);
  }

  /** The key went down. */
  press(): void {
    const me = this.me();
    if (!me) return;
    if (me.guest) return this.say("guest");
    if (me.roomMuted) return this.say("muted");
    this.held = true;
    if (this.transmitting) {
      // Pressed again inside the release tail: the same spurt goes on.
      clearTimeout(this.tailTimer);
      return;
    }
    void this.ensureMic().then((mic) => {
      if (!mic || !this.held || this.transmitting) return;
      this.startSpurt();
    });
  }

  /** The key came up: the tail, then the end of the spurt. */
  release(): void {
    this.held = false;
    if (!this.transmitting) return;
    clearTimeout(this.tailTimer);
    this.tailTimer = window.setTimeout(() => this.stopSpurt(false), RELEASE_TAIL_MS);
  }

  private startSpurt(): void {
    if (!this.mic || !this.enc || !this.room?.open_) return;
    this.transmitting = true;
    this.startFlag = true;
    this.frames = [];
    this.spurtAt = performance.now();
    this.mic.setSending(true);
    this.say(null);
    this.refresh();
  }

  private stopSpurt(now: boolean): void {
    clearTimeout(this.tailTimer);
    if (!this.transmitting) return;
    this.transmitting = false;
    this.mic?.setSending(false);
    const finish = () => {
      // The last frames with VF_END (an empty END is fine: it only closes the spurt).
      const rest = this.frames.splice(0, 3);
      this.sendPacket(rest, VF_END | (this.startFlag ? VF_START : 0));
      this.myLevel = 0;
      this.myPcm = null;
      // The microphone is only ever open while the key is down (and the settings meter): the next press opens it again.
      if (!this.transmitting && !this.held && !this.meters.size) this.closeMicOnly();
      this.refresh();
    };
    if (now || !this.enc) return finish();
    void this.enc.flush().then(finish);
  }

  private sendPacket(frames: Uint8Array[], flags: number): void {
    if (!this.room) return;
    if (!frames.length && !(flags & VF_END)) return;
    const bytes = encodeVoiceUp({ flags, seq: (this.seq = (this.seq + 1) & 0xffff), frames });
    if (this.room.sendBinary(bytes)) {
      this.stats.sentPackets++;
      this.stats.sentFrames += frames.length;
      this.stats.sentBytes += bytes.byteLength;
    }
    this.startFlag = false;
  }

  /** Encoder output: frames only come from encode() calls made during a spurt (and its flush), so all belong to it. */
  private onPacket(bytes: Uint8Array): void {
    this.frames.push(bytes);
    if (this.frames.length >= VOICE_FRAMES_PER_PACKET) this.sendPacket(this.frames.splice(0, VOICE_FRAMES_PER_PACKET), this.startFlag ? VF_START : 0);
  }

  private async ensureMic(): Promise<MicCapture | null> {
    if (this.mic && this.enc) return this.mic;
    this.micOpening ??= (async () => {
      const ctx = (this.engine ??= (await import("../audio")).engine).ctx;
      if (!ctx) return this.fail("unsupported");
      if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
      try {
        const { MicCapture } = await import("./capture");
        const [mic, enc] = await Promise.all([this.mic ?? MicCapture.open(ctx, prefs.get().voice.device), this.enc ?? createEncoder()]);
        this.mic = mic;
        this.enc = enc;
        enc.onPacket = (b) => this.onPacket(b);
        mic.onFrame = (pcm) => {
          if (!this.transmitting) return;
          this.myLevel = levelOf(pcm);
          this.myPcm = pcm;
          if (performance.now() - this.spurtAt > CLIENT_SPURT_MS) {
            this.held = false;
            this.stopSpurt(false);
            return this.say("limit");
          }
          enc.encode(pcm);
        };
        mic.onLevel = (rms) => {
          for (const m of this.meters) m(levelOf(new Float32Array([rms])));
        };
        return mic;
      } catch (e) {
        return this.fail(typeof e === "string" ? (e as MicProblem) : "failed");
      } finally {
        this.micOpening = null;
      }
    })();
    return this.micOpening;
  }

  private fail(p: MicProblem): null {
    this.say(p);
    return null;
  }

  private closeMic(): void {
    this.closeMicOnly();
    this.enc?.close();
    this.enc = null;
  }

  private closeMicOnly(): void {
    this.mic?.close();
    this.mic = null;
  }

  /** The line under the talker list (null clears it), for a few seconds. */
  private say(s: Self): void {
    clearTimeout(this.lineTimer);
    this.hud?.say(s ? SELF_LINES[s] : null);
    if (s) this.lineTimer = window.setTimeout(() => this.hud?.say(null), 3500);
  }

  // ------------------------------------------------------------------ listening

  private ensureBus(): GainNode | null {
    const engine = this.engine;
    const ctx = engine?.ctx;
    if (!engine || !ctx || !engine.master) return null;
    if (this.bus && this.busCtx === ctx) return this.bus;
    this.bus = ctx.createGain();
    this.busCtx = ctx;
    this.bus.gain.value = sliderGain(prefs.get().voice.volume);
    this.bus.connect(engine.master);
    return this.bus;
  }

  private receive(buf: ArrayBuffer): void {
    if (!prefs.get().voice.enabled || !this.host) return;
    const p = decodeVoiceDown(buf);
    if (!p || p.slot === this.host.you()) return;
    this.stats.recvPackets++;
    this.stats.recvFrames += p.frames.length;
    const who = this.host.person(p.slot);
    if (voicePeople.muted(who?.id)) return;
    const bus = this.ensureBus();
    if (!bus) return;
    let t = this.talkers.get(p.slot);
    if (!t) {
      t = new TalkerPlayback(this.engine!.ctx!, bus);
      t.setVolume(voicePeople.volume(who?.id));
      const tap = this.tap;
      if (tap) t.tap = (pcm) => tap(p.slot, pcm);
      this.talkers.set(p.slot, t);
    }
    if (!t.talking) t.since = performance.now();
    t.push(p);
    if (p.flags & VF_START) this.refresh();
  }

  /** Your row's bands: from your latest microphone frame, each frame analysed once. */
  private selfBands(out: Float32Array): boolean {
    const pcm = this.myPcm;
    if (!pcm) return (out.fill(0), false);
    if (this.myBands?.pcm !== pcm || this.myBands.out.length !== out.length) {
      const o = this.myBands?.out.length === out.length ? this.myBands.out : new Float32Array(out.length);
      bandsOf(pcm, o);
      this.myBands = { pcm, out: o };
    }
    out.set(this.myBands.out);
    return true;
  }

  /** Dev only (voice/mock.ts, the party mock's shots): these rows instead of the live talkers. */
  private previewViews: TalkerView[] | null = null;
  preview(views: TalkerView[] | null): void {
    this.previewViews = views;
    this.refresh();
  }

  /** Talking now (a speaker mark by their name): someone else, or you while transmitting. */
  isTalking(slot: number): boolean {
    if (this.previewViews) return this.previewViews.some((v) => v.slot === slot);
    if (slot === this.host?.you()) return this.transmitting;
    const t = this.talkers.get(slot);
    return !!t && t.talking && !voicePeople.muted(this.host?.person(slot)?.id);
  }

  /** Your mute / volume for a player changed (voice/menu.ts). */
  personChanged(slot: number): void {
    const t = this.talkers.get(slot);
    const id = this.host?.person(slot)?.id;
    if (t) t.setVolume(voicePeople.muted(id) ? 0 : voicePeople.volume(id));
    if (t && voicePeople.muted(id)) t.finish();
    this.refresh();
    this.host?.changed?.();
  }

  /** Staff / the lobby host: mute or unmute `slot` for the room. */
  roomMute(slot: number, on: boolean): void {
    this.room?.send({ t: "voiceMute", slot, on });
  }

  canRoomMute(): boolean {
    return !!this.host?.canRoomMute();
  }

  person(slot: number): VoicePerson | null {
    return this.host?.person(slot) ?? null;
  }

  /** A player left: their voice stops at once. */
  left(slot: number): void {
    this.talkers.get(slot)?.close();
    this.talkers.delete(slot);
    this.refresh();
  }

  private refresh(): void {
    if (!this.hud || !this.host) return;
    const now = performance.now();
    const views: TalkerView[] = this.previewViews ? [...this.previewViews] : [];
    const me = this.me();
    if (this.transmitting && me && !this.previewViews) views.push({ key: "self", slot: me.slot, name: me.name, color: me.color, id: me.id, avatarUrl: me.avatarUrl, self: true, level: () => this.myLevel, bands: (out) => this.selfBands(out), look: me.look ?? {} });
    const others = [...this.talkers.entries()].filter(([, t]) => {
      if (t.open && now - t.lastPacket > SILENT_MS) t.finish();
      return t.talking;
    });
    others.sort((a, b) => (a[1].since ?? 0) - (b[1].since ?? 0));
    for (const [slot, t] of others) {
      const p = this.host.person(slot);
      if (!p) continue;
      views.push({ key: String(slot), slot, name: p.name, color: p.color, id: p.id, avatarUrl: p.avatarUrl, level: () => t.level(), bands: (out) => t.bands(out), look: p.look ?? {} });
    }
    this.hud.set(views);
    const key = views.map((v) => v.slot).join(",");
    if (key !== this.talkingKey) {
      this.talkingKey = key;
      this.host.changed?.();
      dispatchEvent(new CustomEvent("voice-talking"));
    }
  }

  // ------------------------------------------------------------------ settings

  /**
   * The settings meter: calls `fn` with the microphone level (0..1) about 20 times a second. Opens the microphone only
   * when `ask` (the Test button) or the browser already allows it without a prompt. Returns the stop function, or null.
   */
  async meter(fn: (level: number) => void, ask: boolean): Promise<(() => void) | null> {
    const { micPermission } = await import("./capture");
    if (!ask && (await micPermission()) !== "granted") return null;
    this.meters.add(fn);
    const mic = await this.ensureMic();
    if (!mic) {
      this.meters.delete(fn);
      return null;
    }
    return () => {
      this.meters.delete(fn);
      if (!this.meters.size && !this.room) this.closeMic();
    };
  }

  /** The key's label for lines and settings ("X"). */
  keyLabel(): string {
    const k = prefs.get().voice.key;
    return k ? keyLabel(k) : "unbound";
  }
}

export const voice = new VoiceController();
if (import.meta.env.DEV && typeof window !== "undefined") Object.assign(window, { __voice: voice });
