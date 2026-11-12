// Your voice choices per player (mute, volume 0-200%), remembered by account id as on the website (voice/people.ts,
// the same storage key), and the room screen's voice controls. The room never learns who you muted: the game applies
// the choices to what it plays (voice_chat.hpp).
import { h } from "../../web/src/ui/dom";
import { can } from "../../web/src/moderation/staff";
import type { RosterPlayer } from "../../web/src/net/protocol";
import type { MenuMessage } from "./bridge";
import type { RoomView } from "./room-service";
import type { VoiceRelay } from "./voice-relay";

const KEY = "bunnyhop:voice-people";
const MAX_PEOPLE = 500;
const MAX_VOLUME = 2;

interface Entry {
  /** Muted. */
  m?: 1;
  /** Volume 0..2 (1 = as sent). */
  v?: number;
  /** Last changed (ms), to drop the oldest past MAX_PEOPLE. */
  t: number;
}
type Store = Record<string, Entry>;

let store: Store | null = null;
let notify: ((people: Store) => void) | null = null;

function read(): Store {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Store) : {};
  } catch {
    return {};
  }
}

const people = (): Store => (store ??= read());

function write(): void {
  const all = people();
  const ids = Object.keys(all);
  if (ids.length > MAX_PEOPLE) {
    const oldest = ids.sort((a, b) => all[a].t - all[b].t).slice(0, ids.length - MAX_PEOPLE);
    for (const id of oldest) delete all[id];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: this session only */
  }
  notify?.(all);
}

function entry(id: string): Entry {
  return (people()[id] ??= { t: 0 });
}

function tidy(id: string): void {
  const e = people()[id];
  e.t = Date.now();
  if (!e.m && e.v === undefined) delete people()[id];
  write();
}

export const voicePeople = {
  muted(id: string | undefined): boolean {
    return !!id && people()[id]?.m === 1;
  },
  volume(id: string | undefined): number {
    const v = id ? people()[id]?.v : undefined;
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(MAX_VOLUME, v)) : 1;
  },
  setMuted(id: string, on: boolean): void {
    const e = entry(id);
    if (on) e.m = 1;
    else delete e.m;
    tidy(id);
  },
  setVolume(id: string, volume: number): void {
    const e = entry(id);
    const v = Math.max(0, Math.min(MAX_VOLUME, volume));
    if (Math.abs(v - 1) < 0.001) delete e.v;
    else e.v = v;
    tidy(id);
  },
  /** Tests: forget the cached copy. */
  reload(): void {
    store = null;
  },
};

/** Sends your choices to the game now and after every change. */
export function installVoicePeople(send: (message: MenuMessage) => void): void {
  notify = (all) => send({ type: "voicePeople", people: all });
  notify(people());
}

/** Staff who may mute players, or a private lobby's host (net/mp.ts canRoomMute on the website). */
export function canRoomMute(view: RoomView): boolean {
  const you = view.players.find((player) => player.slot === view.you);
  const role = you ? (you.role !== undefined ? you.role : you.admin ? "admin" : null) : null;
  return can(role, "player.mute") || (!!view.room?.private && view.room.host === view.you);
}

/** The welcome's room.voice is 1 where the room relays voice (newer than the vendored RoomInfo). */
export const roomRelaysVoice = (view: RoomView): boolean =>
  !!view.room && "voice" in view.room && view.room.voice === 1;

const roomMuted = (player: RosterPlayer): boolean => "voiceMuted" in player && player.voiceMuted === true;

/** A player's voice controls on the room screen: mute, volume and, for staff or the host, the room mute. */
export function voiceControls(view: RoomView, player: RosterPlayer, relay: VoiceRelay): HTMLElement | null {
  if (!roomRelaysVoice(view) || player.slot === view.you) return null;
  const id = player.id;
  const mute = h("button.btn", { type: "button" }) as HTMLButtonElement;
  const paintMute = (): void => {
    mute.textContent = voicePeople.muted(id) ? "Unmute" : "Mute";
  };
  mute.addEventListener("click", () => {
    voicePeople.setMuted(id, !voicePeople.muted(id));
    paintMute();
  });
  paintMute();
  const percent = Math.round(voicePeople.volume(id) * 100);
  const readout = h("output", null, `${percent}%`);
  const volume = h("input", {
    type: "range",
    min: "0",
    max: "200",
    step: "5",
    value: String(percent),
    "aria-label": `${player.name}'s voice volume`,
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    voicePeople.setVolume(id, Number(volume.value) / 100);
    readout.textContent = `${volume.value}%`;
  });
  const muted = roomMuted(player);
  const room =
    canRoomMute(view) && player.provider !== "guest"
      ? h(
          "button.btn",
          { type: "button", onclick: () => relay.roomMute(player.slot, !muted) },
          muted ? "Unmute for the room" : "Mute for the room",
        )
      : null;
  return h(
    "span.native-room-voice",
    { title: "Voice" },
    mute,
    h("label", null, volume, readout),
    muted ? h("small.dim", null, "Muted for the room") : null,
    room,
  );
}
