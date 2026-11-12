// Voice chat's console commands, as on the website: `voice_enable 0|1`, `voice_scale 0-1` and
// `bind <key> +voicerecord` (the push to talk key; it leaves the key's other bind alone). The website's console in
// this menu predates voice, so these lines are answered here before it sees them, in typed lines, pastes and configs.
import { codeForKey, keyForCode } from "../../web/src/console/names";
import { state, type SettingsPatch } from "./bridge";

export interface VoiceConsoleHost {
  settings(): { voiceEnabled: boolean; voiceVolume: number; binds: Record<string, string[]> };
  update(patch: SettingsPatch): void;
}

const words = (line: string): string[] => line.trim().replace(/"/g, " ").split(/\s+/).filter(Boolean);

function cvar(host: VoiceConsoleHost, name: string, value: string | undefined): string {
  const settings = host.settings();
  if (name === "voice_enable") {
    if (value === undefined) return `"voice_enable" = "${settings.voiceEnabled ? 1 : 0}"`;
    if (value !== "0" && value !== "1") return "voice_enable takes 0 or 1.";
    host.update({ voiceEnabled: value === "1" });
    return `voice_enable ${value}`;
  }
  if (value === undefined) return `"voice_scale" = "${settings.voiceVolume}"`;
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale < 0 || scale > 1) return "voice_scale takes 0 to 1.";
  host.update({ voiceVolume: scale });
  return `voice_scale ${scale}`;
}

/** Runs one line if it's a voice command. Returns what to print, or null for any other line. */
export function runVoiceLine(host: VoiceConsoleHost, line: string): string | null {
  const [command, ...rest] = words(line);
  const name = command?.toLowerCase();
  if (name === "voice_enable" || name === "voice_scale") return cvar(host, name, rest[0]);
  if (name === "+voicerecord" || name === "-voicerecord") return "+voicerecord is for keys: bind x +voicerecord";
  if (name !== "bind" || rest.length !== 2 || rest[1].toLowerCase() !== "+voicerecord") return null;
  const code = codeForKey(rest[0]);
  if (!code) return `Unknown key "${rest[0]}".`;
  host.update({ binds: { voiceRecord: [code] } });
  return `"${keyForCode(code)}" = "+voicerecord"`;
}

/** The voice lines a written config carries (host_writeconfig). */
export function voiceConfigLines(host: VoiceConsoleHost): string[] {
  const settings = host.settings();
  const keys = settings.binds.voiceRecord ?? [];
  return [
    ...keys.map((code) => `bind "${keyForCode(code)}" "+voicerecord"`),
    `voice_enable "${settings.voiceEnabled ? 1 : 0}"`,
    `voice_scale "${settings.voiceVolume}"`,
  ];
}

/** Runs a config's voice lines and returns the rest for the website's console. */
export function takeVoiceLines(host: VoiceConsoleHost, text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => runVoiceLine(host, line) === null)
    .join("\n");
}

/** The menu's settings, written through the bridge. */
export function nativeVoiceHost(update: (patch: SettingsPatch) => void): VoiceConsoleHost {
  return { settings: () => state.settings, update };
}
