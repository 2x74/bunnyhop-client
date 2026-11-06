// Command binds and aliases as stored in the settings (ui/settings.ts Prefs.cmdBinds / Prefs.aliases). DOM-free.
//
// Ordinary binds stay in Prefs.binds (an action -> its keys: the Settings -> Keys rows). A key bound to anything else
// (Source's `bind q "+moveleft; +left"`, `bind k "say gg"`, `bind x +mleft` with an alias) is in cmdBinds instead
// (key code -> the command text, run by console/bind-run.ts). A key is in one or the other, never both.

/** Bind codes as Settings stores them (KeyboardEvent.code, Mouse1.., MWheelUp...): settings-io's CODE_RE. */
export const BIND_CODE_RE = /^[A-Za-z0-9]{1,24}$/;
/** Alias names: Source's (letters, digits, _ . and a leading + or - for button aliases). */
export const ALIAS_NAME_RE = /^[+-]?[A-Za-z_][\w.]{0,31}$/;
/** Longest command text a bind or alias keeps (Source's binding buffer is about this). */
export const COMMAND_MAX = 255;
/** At most this many command binds / aliases (a pasted config with more keeps the first ones). */
export const CMD_BINDS_MAX = 64;
export const ALIASES_MAX = 128;

function sanitize(raw: unknown, key: RegExp, max: number, lower: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= max) break;
    if (!key.test(k) || typeof v !== "string" || v.length > COMMAND_MAX) continue;
    const text = v.replace(/[\r\n]+/g, " ").trim();
    if (!text && !lower) continue; // (an alias may be empty: `alias -jt ""` does nothing, on purpose)
    out[lower ? k.toLowerCase() : k] = text;
    n++;
  }
  return out;
}

/** Stored / imported command binds, cleaned: valid codes, one-line text up to COMMAND_MAX, at most CMD_BINDS_MAX. */
export const sanitizeCmdBinds = (raw: unknown): Record<string, string> => sanitize(raw, BIND_CODE_RE, CMD_BINDS_MAX, false);

/** Stored / imported aliases, cleaned (names lower case, as Source matches them). */
export const sanitizeAliases = (raw: unknown): Record<string, string> => sanitize(raw, ALIAS_NAME_RE, ALIASES_MAX, true);

/** The chat message a command bind sends, when the whole bind is one `say` / `say_team` ("gg" for `say gg`). */
export function chatMessageOf(text: string): string | null {
  const m = /^\s*say(?:_team)?\s+(.+?)\s*$/i.exec(text);
  if (!m || /;/.test(m[1].replace(/"[^"]*"/g, ""))) return null;
  const msg = m[1].length >= 2 && m[1].startsWith('"') && m[1].endsWith('"') ? m[1].slice(1, -1) : m[1];
  return msg.trim() ? msg : null;
}

/** A chat message as a bind: `say "nice run"` (quotes so `;` and spaces stay in the message). */
export const sayCommand = (message: string): string => `say "${message.replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim()}"`;
