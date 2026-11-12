import { beforeEach, describe, expect, it } from "bun:test";
import { VoiceRelay, type VoiceSocket } from "./voice-relay";
import { runVoiceLine, takeVoiceLines, voiceConfigLines, type VoiceConsoleHost } from "./voice-console";
import type { MenuMessage } from "./bridge";

class Socket implements VoiceSocket {
  onVoice: ((buf: ArrayBuffer) => void) | null = null;
  controls: unknown[] = [];
  binary: Uint8Array[] = [];
  open = true;
  send(message: never): void {
    this.controls.push(message);
  }
  sendBinary(bytes: Uint8Array<ArrayBuffer>): boolean {
    if (!this.open) return false;
    this.binary.push(bytes);
    return true;
  }
}

function relay(enabled = { on: true }) {
  const sent: MenuMessage[] = [];
  const voice = new VoiceRelay({ send: (message) => sent.push(message), enabled: () => enabled.on });
  const socket = new Socket();
  voice.attach(socket, "voice-bhop", 3);
  return { voice, socket, sent, enabled };
}

const voiceUp = new Uint8Array([0x10, 1, 1, 0, 1, 2, 0xaa, 0xbb]);
const voiceDown = new Uint8Array([0x11, 4, 1, 1, 0, 1, 2, 0xaa, 0xbb]);
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

describe("voice relay", () => {
  it("listens after each welcome of a room with voice, and only there", () => {
    const { voice, socket } = relay();
    voice.welcome({ id: "old-room" });
    expect(socket.controls).toEqual([]);
    voice.welcome({ id: "voice-bhop", voice: 1 });
    voice.welcome({ id: "voice-bhop", voice: 1 });
    expect(socket.controls).toEqual([
      { t: "voice", listen: true },
      { t: "voice", listen: true },
    ]);
  });

  it("tells the room when voice is turned off and on", () => {
    const { voice, socket, enabled } = relay();
    voice.welcome({ voice: 1 });
    enabled.on = false;
    voice.sync();
    voice.sync();
    enabled.on = true;
    voice.sync();
    expect(socket.controls).toEqual([
      { t: "voice", listen: true },
      { t: "voice", listen: false },
      { t: "voice", listen: true },
    ]);
  });

  it("hands VOICE_DOWN frames to the game with the room they came from", () => {
    const { voice, socket, sent } = relay();
    socket.onVoice?.(voiceDown.buffer as ArrayBuffer);
    expect(sent).toEqual([]);
    voice.welcome({ voice: 1 });
    socket.onVoice?.(voiceDown.slice().buffer as ArrayBuffer);
    expect(sent).toEqual([{ type: "voiceDown", id: "voice-bhop", generation: 3, data: base64(voiceDown) }]);
  });

  it("sends the game's VOICE_UP as is, and nothing else", () => {
    const { voice, socket, enabled } = relay();
    expect(voice.up(base64(voiceUp))).toBe(false);
    voice.welcome({ voice: 1 });
    expect(voice.up(base64(voiceUp))).toBe(true);
    expect([...socket.binary[0]]).toEqual([...voiceUp]);
    expect(voice.up(base64(voiceDown))).toBe(false);
    expect(voice.up(base64(new Uint8Array(774).fill(0x10)))).toBe(false);
    expect(voice.up("not base64!")).toBe(false);
    expect(voice.up(42)).toBe(false);
    enabled.on = false;
    voice.sync();
    expect(voice.up(base64(voiceUp))).toBe(false);
    expect(socket.binary.length).toBe(1);
  });

  it("stops at a leave and starts fresh on the next connection", () => {
    const { voice, socket, sent } = relay();
    voice.welcome({ voice: 1 });
    voice.detach();
    expect(socket.onVoice).toBeNull();
    expect(voice.up(base64(voiceUp))).toBe(false);
    const next = new Socket();
    voice.attach(next, "voice-bhop", 4);
    voice.welcome({ voice: 1 });
    next.onVoice?.(voiceDown.slice().buffer as ArrayBuffer);
    expect(sent.at(-1)).toMatchObject({ type: "voiceDown", generation: 4 });
  });

  it("room mutes go to the room only where voice is on", () => {
    const { voice, socket } = relay();
    voice.roomMute(4, true);
    voice.welcome({ voice: 1 });
    voice.roomMute(4, true);
    expect(socket.controls.at(-1)).toEqual({ t: "voiceMute", slot: 4, on: true });
    expect(socket.controls.length).toBe(2);
  });
});

describe("voice console", () => {
  let settings: { voiceEnabled: boolean; voiceVolume: number; binds: Record<string, string[]> };
  let host: VoiceConsoleHost;
  beforeEach(() => {
    settings = { voiceEnabled: true, voiceVolume: 0.8, binds: { voiceRecord: ["KeyX"], cpTeleport: ["KeyX"] } };
    host = {
      settings: () => settings,
      update: (patch) => {
        const { binds, ...rest } = patch;
        Object.assign(settings, rest);
        if (binds) Object.assign(settings.binds, binds);
      },
    };
  });

  it("voice_enable and voice_scale read and set the voice settings", () => {
    expect(runVoiceLine(host, "voice_enable")).toBe('"voice_enable" = "1"');
    expect(runVoiceLine(host, "voice_enable 0")).toBe("voice_enable 0");
    expect(settings.voiceEnabled).toBe(false);
    expect(runVoiceLine(host, 'voice_scale "0.4"')).toBe("voice_scale 0.4");
    expect(settings.voiceVolume).toBe(0.4);
    expect(runVoiceLine(host, "voice_scale 3")).toContain("0 to 1");
    expect(settings.voiceVolume).toBe(0.4);
  });

  it("bind <key> +voicerecord sets push to talk and leaves the key's other bind alone", () => {
    expect(runVoiceLine(host, "bind mouse4 +voicerecord")).toBe('"MOUSE4" = "+voicerecord"');
    expect(settings.binds.voiceRecord).toEqual(["Mouse4"]);
    runVoiceLine(host, 'bind "x" "+voicerecord"');
    expect(settings.binds.voiceRecord).toEqual(["KeyX"]);
    expect(settings.binds.cpTeleport).toEqual(["KeyX"]);
    expect(runVoiceLine(host, "+voicerecord")).toContain("for keys");
    expect(runVoiceLine(host, "bind x +jump")).toBeNull();
    expect(runVoiceLine(host, "sensitivity 2")).toBeNull();
  });

  it("written configs carry the voice lines and exec runs them", () => {
    settings.binds.voiceRecord = ["KeyV"];
    settings.voiceVolume = 0.5;
    const lines = voiceConfigLines(host);
    expect(lines).toEqual(['bind "v" "+voicerecord"', 'voice_enable "1"', 'voice_scale "0.5"']);
    settings.binds.voiceRecord = ["KeyX"];
    settings.voiceVolume = 1;
    const rest = takeVoiceLines(host, ['bind "w" "+forward"', ...lines].join("\n"));
    expect(rest).toBe('bind "w" "+forward"');
    expect(settings.binds.voiceRecord).toEqual(["KeyV"]);
    expect(settings.voiceVolume).toBe(0.5);
  });
});
