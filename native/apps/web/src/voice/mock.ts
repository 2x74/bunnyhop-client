// Dev only: voice chat without a room, for the HUD screenshots (tools/voice/voice-shots.ts) and the visual pass. main.ts
// exposes it as window.__voicemock in dev builds (never in production bundles): the real controller, talker list,
// scoreboard voice buttons, voice menu and name tags, fed by a stand-in room and talkers whose level and bands follow
// a speech-like envelope. Two of the stand-ins are supporters with card looks (frame, background, border, effect, name
// colour / effect / font, avatar decoration), so their rows can be drawn in them.
//
//   __voicemock.show({ talking: [2, 3, 4], self: true })   talker list (yours first while `self`)
//   __voicemock.board(true)                               Tab scoreboard with the voice buttons
//   __voicemock.tags([[2, 105, -28, "Kettle", true]])      bunnies ahead with name tags (the speaker on talkers)

import { voice, type VoicePerson } from "./client";
import type { TalkerLook, TalkerView } from "./hud";
import type { RoomConnection } from "../net/room";
import { slotColor } from "../net/players";
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from "../net/voice-wire";
import { bandsOf } from "./spectrum";

interface MockPlayer {
  slot: number;
  name: string;
  guest?: boolean;
  look?: TalkerLook;
}

/** You are slot 1. */
const YOU = 1;
export const MOCK_PLAYERS: MockPlayer[] = [
  { slot: 1, name: "you" },
  { slot: 2, name: "Kettle", look: { supporter: true, nameColor: "aqua", nameEffect: "glow", nameFont: "round", avatarDeco: "ears", card: { frame: "frame-violet", background: "bg-aurora", border: "comet", effect: "stars" } } },
  { slot: 3, name: "zeb_" },
  { slot: 4, name: "quietstrafe", look: { supporter: true, nameColor: "rose", nameEffect: "paint", nameColor2: "peach", card: { frame: "frame-ember", background: "bg-ember", border: "prism", effect: "embers" } } },
  { slot: 5, name: "lunarpaw" },
  { slot: 6, name: "mossbun" },
  { slot: 7, name: "Cleo", guest: true },
  { slot: 8, name: "hopscotch" },
];

/**
 * Speech as the HUD sees it (voice/codec.ts levelOf maps dB, so a phrase rarely drops to zero): syllable-rate swings
 * over a phrase level, with short pauses between phrases.
 */
function speech(seed: number): () => number {
  const t0 = performance.now() / 1000 - seed * 1.7;
  return () => {
    const t = performance.now() / 1000 - t0;
    const pause = Math.sin(2 * Math.PI * 0.21 * t + seed * 1.3) < -0.8;
    if (pause) return 0.04;
    const v = 0.55 + 0.28 * Math.sin(2 * Math.PI * (3.1 + seed * 0.3) * t + seed) + 0.17 * Math.sin(2 * Math.PI * 5.3 * t + seed * 2) + 0.08 * Math.sin(2 * Math.PI * 11.7 * t);
    return Math.max(0.06, Math.min(1, v));
  };
}

/** A voiced frame (a pitch with falling harmonics) at the envelope's level, through the real band analysis. */
function speechBands(seed: number, level: () => number): (out: Float32Array) => boolean {
  const pcm = new Float32Array(VOICE_FRAME_SAMPLES);
  const f0 = 110 + seed * 37;
  return (out) => {
    const a = Math.pow(level(), 2) * 0.5;
    const ph = performance.now() / 1000;
    for (let i = 0; i < pcm.length; i++) {
      const t = i / VOICE_SAMPLE_RATE + ph;
      let v = 0;
      for (let k = 1; k <= 12; k++) v += Math.sin(2 * Math.PI * f0 * k * t + k * seed) / (k * (1 + 0.4 * Math.sin(ph * 3 + k)));
      pcm[i] = a * v * 0.3;
    }
    bandsOf(pcm, out);
    return a > 0.01;
  };
}

export interface VoiceMockState {
  /** Slots talking (their rows in order). */
  talking: number[];
  /** You transmit (your own row). */
  self?: boolean;
  /** You muted these (their rows dimmed; the board shows the crossed speaker). */
  mutedByYou?: number[];
  /** Muted for the room (roster voiceMuted). */
  roomMuted?: number[];
  /** You're a guest (pressing the key says you need an account). */
  guest?: boolean;
  /** A line under the list. */
  line?: string | null;
}

let attached = false;
let state: VoiceMockState = { talking: [] };

function person(slot: number): VoicePerson | null {
  const p = MOCK_PLAYERS.find((x) => x.slot === slot);
  return p ? { slot, id: `u${slot}`, name: p.name, color: slotColor(slot), guest: slot === YOU ? !!state.guest : !!p.guest, roomMuted: state.roomMuted?.includes(slot), look: p.look ?? {} } : null;
}

const hudParent = () => document.getElementById("hud") ?? document.body;

export function mockVoice(s: VoiceMockState): void {
  state = s;
  if (!attached) {
    attached = true;
    const room = { onVoice: null, send: () => {}, sendBinary: () => true, open_: true } as unknown as RoomConnection;
    voice.attach(room, { you: () => YOU, person, canRoomMute: () => true, playing: () => false, hudParent, changed: () => board && renderBoard() });
    voice.welcome({ voice: 1 });
  }
  const views: TalkerView[] = [];
  const view = (slot: number, seed: number, self = false): TalkerView | null => {
    const p = person(slot);
    if (!p) return null;
    const level = speech(seed);
    return { key: self ? "self" : String(slot), slot, name: p.name, color: p.color, id: p.id, self, mutedByYou: s.mutedByYou?.includes(slot), level, bands: speechBands(seed, level), look: p.look ?? {} };
  };
  if (s.self) views.push(view(YOU, 9, true)!);
  s.talking.forEach((slot, i) => {
    const v = view(slot, i + 1);
    if (v) views.push(v);
  });
  void import("./people").then(({ voicePeople }) => {
    for (const p of MOCK_PLAYERS) voicePeople.setMuted(`u${p.slot}`, !!s.mutedByYou?.includes(p.slot));
    voice.preview(views);
    voice.hud?.say(s.line ?? null);
    if (board) renderBoard();
  });
}

let board: import("../net/hud").Scoreboard | null = null;

function renderBoard(): void {
  if (!board) return;
  board.render(
    { room: "bunnyhop.lol · Easy", map: "bhop_eazy", tier: 1, timeLeft: "18:42", players: MOCK_PLAYERS.length, max: 20, nextMap: null },
    MOCK_PLAYERS.map((p, i) => ({
      slot: p.slot,
      you: p.slot === YOU,
      id: `u${p.slot}`,
      name: p.name,
      color: slotColor(p.slot),
      rank: null,
      role: null,
      style: "auto",
      status: i % 3 === 0 ? "start" : `0:${String(10 + i * 3).padStart(2, "0")}.${String(100 + i * 37).slice(0, 3)}`,
      statusKind: i % 3 === 0 ? "idle" : "running",
      pb: 20 + i * 2.3,
      ping: 30 + i * 9,
      ...(p.look ?? {}),
    })),
  );
}

/** The Tab scoreboard with the voice buttons (white while talking, crossed when muted by you or for the room). */
export async function mockBoard(on: boolean): Promise<void> {
  if (!attached) mockVoice({ talking: [] });
  if (!board) {
    const { Scoreboard } = await import("../net/hud");
    board = new Scoreboard(hudParent());
  }
  renderBoard();
  board.show(on);
}

/**
 * Name tags with the speaker mark: bunnies ahead of you with their tags, `talking` ones showing the speaker in place
 * of the colour dot (as net/players.ts draws a talking player's tag). [slot, ahead, left, name, talking].
 */
export async function mockTags(specs: [number, number, number, string, boolean][]): Promise<void> {
  const w = window as unknown as { bunnyhop?: { scene: { add(o: unknown): void }; camera: { getWorldDirection(v: unknown): { x: number; z: number }; position: { x: number; y: number; z: number } }; core: { state(): { position: number[] } } } };
  const b = w.bunnyhop;
  if (!b) return;
  const [{ PlayerModel }, THREE, { NameTag }] = await Promise.all([import("../player/model"), import("three"), import("../player/tag")]);
  const dir = b.camera.getWorldDirection(new THREE.Vector3());
  const yaw = (Math.atan2(-dir.z, dir.x) * 180) / Math.PI;
  const [x, y, z] = b.core.state().position;
  const f = [Math.cos((yaw * Math.PI) / 180), Math.sin((yaw * Math.PI) / 180)];
  const side = [-f[1], f[0]];
  const models: { update(dt: number): void }[] = [];
  const tags: { tag: InstanceType<typeof NameTag>; at: InstanceType<typeof THREE.Vector3> }[] = [];
  specs.forEach(([slot, ahead, left, name, talking], i) => {
    const m = new PlayerModel({ style: "solid", model: "bunny", outfit: ["outfit-cream", "outfit-bune", "outfit-plush"][i % 3] });
    b.scene.add(m.root);
    const px = x + f[0] * ahead + side[0] * left;
    const py = y + f[1] * ahead + side[1] * left;
    m.setState({ position: [px, py, z], yaw: yaw + 180, pitch: 0, crouched: false, grounded: true });
    m.snap();
    models.push(m);
    const tag = new NameTag(slotColor(slot));
    tag.set(name, "", null, false, null, false, talking);
    b.scene.add(tag.sprite);
    tags.push({ tag, at: new THREE.Vector3(px, z + 76, -py) });
  });
  let last = performance.now();
  const cam = new THREE.Vector3();
  const tick = (t: number) => {
    for (const m of models) m.update(Math.min(0.05, (t - last) / 1000));
    last = t;
    cam.set(b.camera.position.x, b.camera.position.y, b.camera.position.z);
    for (const { tag, at } of tags) tag.place(at, cam, 1);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
