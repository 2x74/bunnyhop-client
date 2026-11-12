// Voice chat's side of the room socket. The game does the audio (voice_chat.hpp); this hands it the VOICE_DOWN frames
// the room sends and puts its VOICE_UP packets on the socket, both as they are (net/voice-wire.ts on the website).
// It also tells the room whether this socket listens: after every welcome of a room that relays voice, and whenever
// voice is turned on or off. A socket that never says so gets no voice at all.
import { base64Bytes } from "./base64";
import type { MenuMessage } from "./bridge";

const MSG_VOICE_UP = 0x10;
/** The largest VOICE_UP the room accepts (net/voice-wire.ts MAX_VOICE_UP_BYTES). */
const MAX_VOICE_UP_BYTES = 773;

/** The parts of a room connection voice needs (RoomConnection, or a test's stand-in). */
export interface VoiceSocket {
  onVoice?: ((buf: ArrayBuffer) => void) | null;
  sendBinary?(bytes: Uint8Array<ArrayBuffer>): boolean;
  send(message: never): void;
}

export interface VoiceRelayDependencies {
  send(message: MenuMessage): void;
  /** Voice on in settings (voiceEnabled). */
  enabled(): boolean;
}

export type VoiceControl = { t: "voice"; listen: boolean } | { t: "voiceMute"; slot: number; on: boolean };

export class VoiceRelay {
  private socket: VoiceSocket | null = null;
  private room: { id: string; generation: number } | null = null;
  private active = false;
  private listening: boolean | null = null;

  constructor(private dependencies: VoiceRelayDependencies) {}

  /** A new connection for room `id` (each reconnect and map change makes one). */
  attach(socket: VoiceSocket, id: string, generation: number): void {
    this.detach();
    this.socket = socket;
    this.room = { id, generation };
    socket.onVoice = (buf) => this.down(buf);
  }

  detach(): void {
    if (this.socket) this.socket.onVoice = null;
    this.socket = null;
    this.room = null;
    this.active = false;
    this.listening = null;
  }

  /** Every welcome: does this room relay voice (room.voice is 1)? */
  welcome(room: object | null | undefined): void {
    this.active = !!room && "voice" in room && room.voice === 1;
    this.listening = null;
    this.sync();
  }

  /** Settings changed: say so if voice was turned on or off. */
  sync(): void {
    if (!this.active || !this.socket) return;
    const listen = this.dependencies.enabled();
    if (listen === this.listening) return;
    this.listening = listen;
    this.control({ t: "voice", listen });
  }

  /** A VOICE_UP from the game, base64. Only a well-formed packet of the right type goes out. */
  up(data: unknown): boolean {
    if (!this.active || !this.listening || !this.socket?.sendBinary || typeof data !== "string") return false;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } catch {
      return false;
    }
    if (bytes.length < 5 || bytes.length > MAX_VOICE_UP_BYTES || bytes[0] !== MSG_VOICE_UP) return false;
    return this.socket.sendBinary(bytes);
  }

  /** Staff or a lobby's host: mute or unmute a player's voice for the room. */
  roomMute(slot: number, on: boolean): void {
    if (this.active) this.control({ t: "voiceMute", slot, on });
  }

  private control(message: VoiceControl): void {
    // The vendored protocol predates voice; the room validates these itself.
    this.socket?.send(message as never);
  }

  private down(buf: ArrayBuffer): void {
    if (!this.active || !this.listening || !this.room) return;
    const { id, generation } = this.room;
    this.dependencies.send({ type: "voiceDown", id, generation, data: base64Bytes(new Uint8Array(buf)) });
  }
}
