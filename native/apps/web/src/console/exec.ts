// The console's commands (console/view.ts types into it; Settings → Keys → Import a CS:S config uses importConfig).
// Source syntax (parse.ts), Source key and command names (names.ts), cvars over the settings store (cvars.ts).
// A client settings tool: it changes prefs (the same store and validation the Settings page uses) and can ask the
// game to run a bound action or a chat command. It never touches a room, the server or the anticheat. DOM-free.
//
// Binds: a key bound to one action is an ordinary bind (Prefs.binds: the Settings → Keys rows). Anything else, a chain
// (`bind q "+moveleft; +left"`), an alias (`bind q +mleft`) or a chat line (`bind k "say gg"`, `bind f "say !r"`), is a
// command bind (Prefs.cmdBinds; console/bind-run.ts runs it like Source). Chat from a key goes through the same chat path
// as typing it (rooms: the server's limits, filters and mutes) behind a small client guard (ChatGuard).

import { DEFAULT_BINDS, type BindAction } from "../binds";
import { DEFAULT_PREFS, assignBindSlot, type Action, type Prefs } from "../ui/settings";
import { argString, quoteArg, splitCommands, tokenize } from "./parse";
import { actionForCommand, codeForKey, commandForAction, keyForCode, COMMAND_LIST, KEY_LIST, UNSUPPORTED_COMMANDS } from "./names";
import { CVARS, describeCvar, findCvar, fmtCvar, isServerCvar, parseCvar, setCvar, UNSUPPORTED_CVARS, WRITTEN_CVARS } from "./cvars";
import { ALIAS_NAME_RE, chatMessageOf, COMMAND_MAX } from "./bind-store";
import { mixesMoveAndTurn, MOVE_TURN_REFUSAL, runPress } from "./bind-run";

export type LineKind = "out" | "echo" | "err" | "ok" | "dim";

/** What the console runs against. main.ts supplies the game hooks; tests pass a plain prefs object. */
export interface ConsoleHost {
  get(): Prefs;
  update(fn: (p: Prefs) => void): void;
  print(text: string, kind?: LineKind): void;
  clear(): void;
  /**
   * Runs a chat command line ("!r", "/cp") or chat ("hi") as if typed in the chat; false when there's no game to run
   * it in. Local answers go to `reply`.
   */
  chat?(line: string, reply: (text: string) => void): boolean;
  /** A short line for the player when a key's command had something to say (the game's quiet notice). */
  notice?(text: string): void;
  /** Runs a bound action now (`restart`, `noclip`, `jump_toggle`); false when there's no game. */
  action?(a: Action): boolean;
  /** ms clock (unbindall's confirmation window). */
  now?(): number;
  /** `retry`: reload this map; false when there's no map. */
  retry?(): boolean;
  /** `map <name>`: open a map (any page); the error to print, or null when it's going. */
  openMap?(name: string): string | null;
  /** `disconnect` / `quit`: back to the main menu; false when already there. */
  menu?(): boolean;
  /** Saved configs (host_writeconfig / exec): name -> Source config text, kept in this browser. */
  configs?: ConfigStore;
}

/** Where host_writeconfig keeps configs (view.ts: localStorage). `set` returns why it couldn't, or null. */
export interface ConfigStore {
  list(): string[];
  get(name: string): string | null;
  set(name: string, text: string): string | null;
}

/** Keys / actions per bind row on the Keys page: a fourth key goes on, the oldest comes off. */
const MAX_KEYS = 3;
/** Actions with a Source command of their own (a CS:S config binds them). Everything else is this game's own. */
const SOURCE_ACTIONS = new Set<Action>(["forward", "back", "left", "right", "jump", "duck", "use", "attack", "attack2", "turnLeft", "turnRight", "turnFast", "slot1", "slot2", "slot3", "lastWeapon", "nextWeapon", "prevWeapon", "drop", "reload", "inspect", "chat", "console", "flashlight"]);
/** This game's own actions (restart, checkpoints, the jump toggle...): a pasted config leaves their keys alone by default. */
export const ownAction = (a: Action): boolean => !SOURCE_ACTIONS.has(a);

const actions = (b: Prefs["binds"]) => Object.keys(b) as Action[];
/** The action `code` is bound to, if any. */
export const actionOfKey = (b: Prefs["binds"], code: string): Action | null => actions(b).find((a) => b[a].includes(code)) ?? null;

/**
 * Takes `code` off every action. A wheel direction also comes off a "MouseWheel" (either direction) bind, which keeps
 * the other direction: `unbind mwheelup` with jump on the wheel leaves jump on MWHEELDOWN.
 */
export function unbindKey(b: Prefs["binds"], code: string): Action[] {
  const took: Action[] = [];
  const other = code === "MWheelUp" ? "MWheelDown" : code === "MWheelDown" ? "MWheelUp" : null;
  for (const a of actions(b)) {
    if (b[a].includes(code)) {
      b[a] = b[a].filter((c) => c !== code);
      took.push(a);
    }
    if (other && b[a].includes("MouseWheel")) {
      b[a] = b[a].map((c) => (c === "MouseWheel" ? other : c));
      if (!took.includes(a)) took.push(a);
    }
    if (code === "MouseWheel" && b[a].some((c) => c === "MWheelUp" || c === "MWheelDown")) {
      b[a] = b[a].filter((c) => c !== "MWheelUp" && c !== "MWheelDown");
      took.push(a);
    }
  }
  return took;
}

/** Binds `code` to `action` (Settings → Keys's rules: the key leaves other actions). Returns the actions it left. */
export function bindKey(b: Prefs["binds"], code: string, action: Action): Action[] {
  if (b[action].includes(code)) return [];
  const took = unbindKey(b, code).filter((a) => a !== action);
  if (b[action].length >= MAX_KEYS) b[action] = b[action].slice(b[action].length - MAX_KEYS + 1);
  assignBindSlot(b, action, b[action].length, code);
  // Both wheel directions on one action: the one either-direction code (the default jump bind's).
  if (b[action].includes("MWheelUp") && b[action].includes("MWheelDown")) {
    const at = b[action].findIndex((c) => c === "MWheelUp" || c === "MWheelDown");
    b[action] = b[action].filter((c) => c !== "MWheelUp" && c !== "MWheelDown");
    b[action].splice(at, 0, "MouseWheel");
  }
  return took;
}

/**
 * Why `alias name "text"` can't be defined: it would move and turn on one press itself, or make a key's bind do so.
 * Null when it's fine.
 */
export function aliasMoveTurn(p: Prefs, name: string, text: string): string | null {
  const next = { ...(p.aliases ?? {}), [name]: text };
  if (mixesMoveAndTurn(name, next)) return MOVE_TURN_REFUSAL;
  for (const [code, bind] of Object.entries(p.cmdBinds ?? {})) if (mixesMoveAndTurn(bind, next)) return `${MOVE_TURN_REFUSAL.replace(/\.$/, "")}: ${keyForCode(code)} is bound to ${bind}.`;
  return null;
}

/** What `code` runs, as a command line ("+jump", "+moveleft; +left", "say gg"), or null when it's unbound. */
export function bindingOf(p: Prefs, code: string): string | null {
  const cmd = p.cmdBinds?.[code];
  if (cmd !== undefined) return cmd;
  const a = actionOfKey(p.binds, code);
  return a ? commandForAction(a) : null;
}

/** Takes `code` off command binds too (a wheel direction splits an either-direction command bind, as for actions). */
export function uncommand(p: Prefs, code: string): boolean {
  const c = (p.cmdBinds ??= {});
  let had = code in c;
  delete c[code];
  const other = code === "MWheelUp" ? "MWheelDown" : code === "MWheelDown" ? "MWheelUp" : null;
  if (other && "MouseWheel" in c) {
    c[other] = c.MouseWheel;
    delete c.MouseWheel;
    had = true;
  }
  if (code === "MouseWheel") for (const w of ["MWheelUp", "MWheelDown"]) if (w in c) (delete c[w], (had = true));
  return had;
}

/** Binds `code` to one action (an ordinary bind). Returns the actions the key left. */
export function bindAction(p: Prefs, code: string, action: Action): Action[] {
  uncommand(p, code);
  return bindKey(p.binds, code, action);
}

/** Binds `code` to a command line (a chain, an alias, a chat line). Returns the actions the key left. */
export function bindCommand(p: Prefs, code: string, text: string): Action[] {
  const took = unbindKey(p.binds, code);
  uncommand(p, code);
  p.cmdBinds = { ...p.cmdBinds, [code]: text.trim() };
  return took;
}

/** Unbinds `code` from whatever it runs. True if it was bound. */
export function unbindIn(p: Prefs, code: string): boolean {
  const took = unbindKey(p.binds, code);
  return uncommand(p, code) || took.length > 0;
}

/** Every bound key and its command, Source style, in key order. */
export function listBinds(p: Prefs): string[] {
  const out: [string, string][] = [];
  for (const a of actions(p.binds)) for (const c of p.binds[a]) out.push([keyForCode(c), commandForAction(a)]);
  for (const [c, text] of Object.entries(p.cmdBinds ?? {})) out.push([keyForCode(c), text.replace(/"/g, "'")]);
  if (p.voice?.key) out.push([keyForCode(p.voice.key), "+voicerecord"]);
  return out.sort((x, y) => x[0].localeCompare(y[0])).map(([k, c]) => `"${k}" = "${c}"`);
}

/**
 * Client guard for chat sent by keys (`bind k "say gg"`): at most one bound message a second and three in ten seconds,
 * so holding or mashing a chat key can't flood a room or use up the room's own limit (apps/api rooms: a burst of 4,
 * one more every 1.5 s, the same line twice in 5 s dropped) that typed chat shares. Chat commands (!r, !cp) aren't
 * messages and aren't limited here.
 */
export class ChatGuard {
  private sent: number[] = [];
  constructor(readonly gapMs = 1000, readonly burst = 3, readonly windowMs = 10_000) {}
  /** True if a bound message may go now (and counts it). */
  allow(now: number): boolean {
    this.sent = this.sent.filter((t) => now - t < this.windowMs);
    const last = this.sent[this.sent.length - 1];
    if (last !== undefined && now - last < this.gapMs) return false;
    if (this.sent.length >= this.burst) return false;
    this.sent.push(now);
    return true;
  }
}

/** A chat line that's a chat command (!r, /cp), not a message to people. */
export const isChatCommand = (line: string): boolean => /^[!/.]\S/.test(line.trim());

/** Names a command line can run: console commands, cvars, actions, aliases (for a bind's warnings). */
function knownName(name: string, aliases: Readonly<Record<string, string>>): boolean {
  return COMMAND_NAMES.has(name) || name === "alias" || name === "unalias" || !!findCvar(name) || !!actionForCommand(name) || Object.prototype.hasOwnProperty.call(aliases, name) || /^[!/]\S/.test(name);
}

/** The commands in a bind that do nothing here (unknown names, Source commands this game doesn't have). */
export function unknownIn(text: string, aliases: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const cmd of splitCommands(text)) {
    const name = (tokenize(cmd)[0] ?? "").toLowerCase();
    if (!name) continue;
    const base = /^[+-]/.test(name) && !Object.prototype.hasOwnProperty.call(aliases, name) ? "+" + name.slice(1) : name;
    if (!knownName(base, aliases) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Console commands, for help, find and tab completion. */
export const COMMANDS: readonly { name: string; args?: string; help: string }[] = [
  { name: "bind", args: "<key> [command]", help: "Bind a key, or show what it does." },
  { name: "unbind", args: "<key>", help: "Unbind a key." },
  { name: "unbindall", help: "Unbind every key except Esc and the console key (asks first)." },
  { name: "binds_default", help: "Put every key back to its default." },
  { name: "binds", help: "List every bound key." },
  { name: "alias", args: "[name] [commands]", help: "Name a command line (alias +x / -x for a key that holds). No name: list them." },
  { name: "unalias", args: "<name>", help: "Remove an alias." },
  { name: "toggle", args: "<cvar> [a b ...]", help: "Flip a setting between 0 and 1, or step through the values given." },
  { name: "incrementvar", args: "<cvar> <min> <max> <step>", help: "Step a setting, wrapping inside min and max." },
  { name: "cvarlist", help: "List every setting." },
  { name: "find", args: "<text>", help: "Find settings and commands by name or description." },
  { name: "help", args: "[name]", help: "Show the commands, or explain one." },
  { name: "echo", args: "<text>", help: "Print text." },
  { name: "clear", help: "Clear the console." },
  { name: "say", args: "<text>", help: "Chat in a server. In solo, runs chat commands like !r." },
  { name: "cfg_undo", help: "Undo the last pasted config or exec." },
  { name: "kill", help: "Restart the run (your start zone)." },
  { name: "retry", help: "Reload this map." },
  { name: "map", args: "<name>", help: "Open a map. Tab completes the names." },
  { name: "disconnect", help: "Back to the main menu (also quit, exit)." },
  { name: "noclip", help: "Practice noclip, where practice allows it." },
  { name: "exec", args: "[name]", help: "Load a saved config. No name: list them." },
  { name: "host_writeconfig", args: "[name]", help: "Save your binds, aliases and settings as a config (also writecfg)." },
  { name: "wait", help: "In a key's alias: run the rest one tick later." },
];

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name).concat(["key_listboundkeys", "say_team", "writecfg", "quit", "exit", "unalias"]));

/** Edit distance (did-you-mean). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Every name the console knows (commands, cvars and their aliases, bind commands). */
export const ALL_NAMES: readonly string[] = [...new Set([...COMMAND_NAMES, ...CVARS.flatMap((c) => [c.name, ...(c.aliases ?? []).filter((a) => !a.startsWith("bh_"))]), ...COMMAND_LIST.filter((c) => !c.includes(" "))])].sort();
/** Saved config names, for exec's completion (view.ts keeps it current). */
let completeConfigs: readonly string[] = [];
export const setConfigNames = (names: readonly string[]): void => void (completeConfigs = names);

function suggest(name: string): string | null {
  let best: string | null = null;
  let bd = Infinity;
  for (const n of ALL_NAMES) {
    const d = n.startsWith(name) ? 0.5 : distance(name, n);
    if (d < bd) (bd = d), (best = n);
  }
  return bd <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

/**
 * Tab completion: the line completed as far as it's certain, plus the candidates. First word: commands and cvars;
 * after `bind` / `unbind`: key names, then bind commands; after `help` / `toggle` / `find`: names / cvars.
 */
export function complete(line: string, maps: readonly string[] = []): { line: string; options: string[] } {
  const words = tokenize(line);
  const trailing = /\s$/.test(line);
  const idx = trailing ? words.length : Math.max(0, words.length - 1);
  const cur = trailing ? "" : (words[idx] ?? "").toLowerCase();
  const first = (words[0] ?? "").toLowerCase();
  let pool: readonly string[];
  if (idx === 0) pool = ALL_NAMES;
  else if ((first === "bind" || first === "unbind") && idx === 1) pool = KEY_LIST.map((k) => k.toLowerCase());
  else if (first === "bind" && idx === 2) pool = COMMAND_LIST;
  else if ((first === "toggle" || first === "incrementvar") && idx === 1) pool = CVARS.map((c) => c.name);
  else if (first === "help" && idx === 1) pool = ALL_NAMES;
  else if (first === "map" && idx === 1) pool = maps;
  else if ((first === "exec" || first === "host_writeconfig" || first === "writecfg") && idx === 1) pool = completeConfigs;
  else return { line, options: [] };
  const options = pool.filter((n) => n.toLowerCase().startsWith(cur));
  if (!options.length) return { line, options };
  let common = options[0];
  for (const o of options) while (!o.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
  const head = trailing ? line : line.slice(0, line.length - (words[idx]?.length ?? 0)).replace(/"$/, "");
  const done = options.length === 1 ? quoteArg(options[0]) + " " : quoteArg(common.length >= cur.length ? common : cur);
  return { line: head + done, options: options.length === 1 ? [] : options };
}

// ------------------------------------------------------------------------------------------------- running

interface RunState {
  /** unbindall asked: until this time a second unbindall goes through (0: not asked). */
  unbindAllUntil: number;
  /** Prefs before the last pasted config (cfg_undo). */
  undo: string | null;
}

/** One console: its unbindall confirmation and the last paste's undo. */
export class ConsoleRunner {
  private state: RunState = { unbindAllUntil: 0, undo: null };
  /** Running a key's command (runBound): no echo, and problems also go to host.notice. */
  private bound = 0;
  /** Bound chat messages (ChatGuard); `guarded`: the last refusal was already said. */
  readonly guard = new ChatGuard();
  private guarded = false;
  constructor(private host: ConsoleHost) {}

  private now = () => this.host.now?.() ?? Date.now();

  private out(text: string, kind: LineKind = "out"): void {
    this.host.print(text, kind);
    if (this.bound && kind === "err") this.host.notice?.(text);
  }

  /** Runs a typed line: every `;`-separated command in it. */
  run(line: string): void {
    for (const c of splitCommands(line)) this.command(c);
  }

  /** A key's once-command (input.ts onCommand: `say gg`, `slot1`, `toggle cl_showpos 0 1`): run without an echo. */
  runBound(command: string): void {
    this.bound++;
    try {
      this.command(command);
    } finally {
      this.bound--;
    }
  }

  /** A pasted config: everything in it at once, with a report and cfg_undo. Returns the import's report. */
  paste(text: string, o: ImportOptions = {}): ImportReport {
    const before = JSON.stringify(this.host.get());
    const report = importConfig(text, this.host.get(), o);
    if (report.changed) {
      this.host.update((p) => Object.assign(p, report.prefs));
      this.state.undo = before;
    }
    for (const l of reportLines(report)) this.host.print(l.text, l.kind);
    return report;
  }

  private command(cmd: string): void {
    const h = this.host;
    const words = tokenize(cmd);
    if (!words.length) return;
    const name = words[0].toLowerCase();
    const args = words.slice(1);
    if (!this.bound) h.print(`] ${cmd}`, "echo");
    // Chat commands: !r, /cp (a leading / or ! word), and say / say_team.
    if (/^[!/]\S/.test(words[0])) return this.chat(cmd.trim());
    switch (name) {
      case "say":
      case "say_team": {
        const text = argString(cmd);
        if (!text) return h.print("Usage: say <text>", "err");
        return this.chat(text);
      }
      case "echo":
        return h.print(argString(cmd));
      case "clear":
        return h.clear();
      case "help":
        return this.help(args[0]);
      case "find":
        return this.find(args.join(" "));
      case "cvarlist":
        for (const c of CVARS) h.print(`${describeCvar(c, h.get())}  ${c.help}`, "dim");
        return h.print(`${CVARS.length} settings.`);
      case "binds":
      case "key_listboundkeys": {
        const lines = listBinds(h.get());
        for (const l of lines) h.print(l, "dim");
        return h.print(`${lines.length} keys bound.`);
      }
      case "bind":
        return this.bind(args);
      case "unbind":
        return this.unbind(args);
      case "unbindall":
        return this.unbindAll();
      case "binds_default":
        h.update((p) => ((p.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS))), (p.cmdBinds = {})));
        return h.print("Every key is back to its default.", "ok");
      case "toggle":
        return this.toggle(args);
      case "incrementvar":
        return this.increment(args);
      case "cfg_undo": {
        if (!this.state.undo) return h.print("Nothing to undo.", "err");
        const prev = JSON.parse(this.state.undo) as Prefs;
        this.state.undo = null;
        h.update((p) => Object.assign(p, prev));
        return h.print("Put back the settings from before the paste.", "ok");
      }
      case "exec":
        return this.exec(args);
      case "host_writeconfig":
      case "writecfg":
        return this.writeConfig(args);
      case "wait":
        return; // (a key's alias: bind-run.ts; typed, there's nothing to wait for)
      case "kill":
        if (!h.action?.("restart")) this.out("kill: only in a map.", "err");
        return;
      case "retry":
        if (!h.retry?.()) this.out("retry: only in a map.", "err");
        return;
      case "map": {
        if (!args[0]) return this.out("Usage: map <name>. Tab completes the names.", "err");
        const why = h.openMap ? h.openMap(args[0]) : "Maps open from the game.";
        if (why) this.out(why, "err");
        return;
      }
      case "disconnect":
      case "quit":
      case "exit":
        if (!h.menu?.()) this.out("Already in the menu.", "dim");
        return;
      case "alias":
        return this.alias(cmd, args);
      case "unalias": {
        const n = (args[0] ?? "").toLowerCase();
        if (!n || !(n in h.get().aliases)) return this.out(n ? `No alias "${n}".` : "Usage: unalias <name>", "err");
        h.update((p) => delete p.aliases[n]);
        return this.out(`Removed alias "${n}".`, "ok");
      }
    }
    if (Object.prototype.hasOwnProperty.call(h.get().aliases ?? {}, name)) return this.runAlias(name);
    const cvar = findCvar(name);
    if (cvar) {
      if (!args.length) return h.print(`${describeCvar(cvar, h.get())}\n - ${cvar.help}`);
      let why: string | null = null;
      h.update((p) => (why = setCvar(p, cvar, args[0])));
      return why ? h.print(why, "err") : h.print(`${cvar.name} ${fmtCvar(cvar.get(h.get()))}`, "ok");
    }
    if (name === "+voicerecord" || name === "-voicerecord") return h.print(`${name} is for keys: bind one, e.g. bind x +voicerecord (now ${keyForCode(h.get().voice.key) || "unbound"}).`, "dim");
    if (name.startsWith("+") || name.startsWith("-")) {
      const a = actionForCommand(name.replace(/^-/, "+"));
      return h.print(a ? `${name} is for keys: bind one, e.g. bind space ${commandForAction(a)}.` : `Unknown command "${name}".`, a ? "dim" : "err");
    }
    const action = actionForCommand(cmd);
    if (action) {
      if (action === "console") return;
      if (!h.action?.(action)) h.print(`${name}: only in a map.`, "err");
      return;
    }
    if (UNSUPPORTED_CVARS[name]) return h.print(`${name}: ${UNSUPPORTED_CVARS[name]}.`, "err");
    if (UNSUPPORTED_COMMANDS[name]) return h.print(`${name}: ${UNSUPPORTED_COMMANDS[name]}.`, "err");
    if (isServerCvar(name)) return h.print(`${name} is a server setting. The console only changes yours.`, "err");
    const s = suggest(name);
    h.print(`Unknown command "${name}".${s ? ` Did you mean ${s}?` : " Type help for the list."}`, "err");
  }

  private chat(line: string): void {
    const bound = this.bound > 0;
    if (bound && !isChatCommand(line)) {
      if (!this.guard.allow(this.now())) {
        // Said once per run of refusals (holding the key doesn't print a line a frame).
        if (!this.guarded) this.out("Chat key: one message a second, three every ten seconds.", "err");
        this.guarded = true;
        return;
      }
      this.guarded = false;
    }
    const reply = (t: string) => (this.host.print(t), bound && this.host.notice?.(t));
    if (!this.host.chat?.(line, reply)) this.out(bound ? "Chat keys work in a map." : "Chat commands work in a map.", "err");
  }

  /** `alias`, `alias name`, `alias name commands`. */
  private alias(cmd: string, args: string[]): void {
    const h = this.host;
    const aliases = h.get().aliases ?? {};
    if (!args.length) {
      const names = Object.keys(aliases).sort();
      for (const n of names) h.print(`${n} : ${aliases[n]}`, "dim");
      return this.out(names.length ? `${names.length} alias${names.length === 1 ? "" : "es"}.` : "No aliases.");
    }
    const name = args[0].toLowerCase();
    if (!ALIAS_NAME_RE.test(name)) return this.out(`"${args[0]}" can't be an alias name.`, "err");
    if (args.length === 1) return this.out(name in aliases ? `${name} : ${aliases[name]}` : `No alias "${name}".`, name in aliases ? "out" : "err");
    if (findCvar(name) || COMMAND_NAMES.has(name)) return this.out(`"${name}" is already a command.`, "err");
    // Source: everything after the name, one pair of outer quotes removed.
    const text = argString(argString(cmd)).trim(); // (after "alias", then after the name)
    if (text.length > COMMAND_MAX) return this.out("That alias is too long.", "err");
    const why = aliasMoveTurn(h.get(), name, text);
    if (why) return this.out(why, "err");
    h.update((p) => (p.aliases = { ...p.aliases, [name]: text }));
    if (!this.bound) this.out(`alias ${name} "${text}"`, "ok");
  }

  /** An alias typed in the console: its once-commands run; + / - holds are for keys. */
  private runAlias(name: string): void {
    let held = false;
    runPress(name, this.host.get().aliases ?? {}, {
      hold: () => (held = true),
      unhold: () => {},
      once: (c) => this.command(c),
      error: (t) => this.out(t, "err"),
    });
    if (held && !this.bound) this.out(`${name} holds keys: bind it to a key to use it.`, "dim");
  }

  private help(name?: string): void {
    const h = this.host;
    if (!name) {
      h.print("Commands:");
      for (const c of COMMANDS) h.print(`  ${c.name}${c.args ? ` ${c.args}` : ""}  ${c.help}`, "dim");
      h.print("Settings: cvarlist lists them all, find <text> searches. Type a setting's name to see it, or name and value to set it.");
      h.print("Chat commands work too: !r, !practice, say !cp.");
      return;
    }
    const n = name.toLowerCase();
    const cmd = COMMANDS.find((c) => c.name === n);
    if (cmd) return h.print(`${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}: ${cmd.help}`);
    const cvar = findCvar(n);
    if (cvar) return h.print(`${describeCvar(cvar, h.get())}\n - ${cvar.help}`);
    const a = actionForCommand(n);
    if (a) return h.print(`${commandForAction(a)}: a bind command (${a}).`);
    h.print(`No help for "${name}".`, "err");
  }

  private find(text: string): void {
    const h = this.host;
    const q = text.trim().toLowerCase();
    if (!q) return h.print("Usage: find <text>", "err");
    let n = 0;
    for (const c of CVARS) if (c.name.includes(q) || c.help.toLowerCase().includes(q) || c.aliases?.some((a) => a.includes(q))) (h.print(`${describeCvar(c, h.get())}  ${c.help}`, "dim"), n++);
    for (const c of COMMANDS) if (c.name.includes(q) || c.help.toLowerCase().includes(q)) (h.print(`${c.name}  ${c.help}`, "dim"), n++);
    for (const c of COMMAND_LIST) if (c.includes(q)) (h.print(`${c}  (bind command)`, "dim"), n++);
    if (!n) h.print(`Nothing matches "${text}".`, "err");
  }

  private bind(args: string[]): void {
    const h = this.host;
    if (!args.length) return h.print("Usage: bind <key> [command]", "err");
    const code = codeForKey(args[0]);
    if (!code) return h.print(`"${args[0]}" isn't a key name. Examples: mouse4, mwheeldown, space, ctrl, f, kp_end.`, "err");
    if (args.length === 1) {
      const b = bindingOf(h.get(), code);
      return h.print(b !== null ? `"${keyForCode(code)}" = "${b}"` : `"${keyForCode(code)}" is not bound`);
    }
    // Voice chat's push to talk is its own key (Prefs.voice.key): in rooms it talks, so the key can keep a solo bind.
    if (/^\+voicerecord$/i.test(args.slice(1).join(" ").trim().replace(/^"|"$/g, ""))) {
      h.update((p) => (p.voice.key = code));
      return this.out(`"${keyForCode(code)}" = "+voicerecord" (push to talk in rooms)`, "ok");
    }
    const r = bindPlan(code, args.slice(1).join(" "));
    if ("error" in r) return this.out(r.error, "err");
    if ("command" in r && mixesMoveAndTurn(r.command, h.get().aliases ?? {})) return this.out(MOVE_TURN_REFUSAL, "err");
    let took: Action[] = [];
    h.update((p) => (took = "action" in r ? bindAction(p, code, r.action) : bindCommand(p, code, r.command)));
    const gone = took.length ? ` (it was ${took.map(commandForAction).join(", ")})` : "";
    this.out(`"${keyForCode(code)}" = "${"action" in r ? commandForAction(r.action) : r.command}"${gone}`, "ok");
    if ("command" in r) {
      const unknown = unknownIn(r.command, h.get().aliases ?? {});
      if (unknown.length) this.out(`Not a command here (yet): ${unknown.join(", ")}. An alias of that name will make it work.`, "dim");
    }
  }

  private unbind(args: string[]): void {
    const h = this.host;
    if (!args.length) return h.print("Usage: unbind <key>", "err");
    const code = codeForKey(args[0]);
    if (!code) return h.print(`"${args[0]}" isn't a key name.`, "err");
    if (code === "Escape") return h.print("Esc always opens the menu.", "err");
    let had = false;
    h.update((p) => (had = unbindIn(p, code)));
    h.print(had ? `Unbound "${keyForCode(code)}".` : `"${keyForCode(code)}" wasn't bound.`, had ? "ok" : "dim");
  }

  private unbindAll(): void {
    const h = this.host;
    if (!this.state.unbindAllUntil || this.now() > this.state.unbindAllUntil) {
      this.state.unbindAllUntil = this.now() + 10_000;
      return h.print("This unbinds every key except Esc and the console key. Type unbindall again within 10 seconds to do it. binds_default puts the defaults back.");
    }
    this.state.unbindAllUntil = 0;
    h.update((p) => (unbindAllIn(p.binds), (p.cmdBinds = {})));
    h.print("Unbound every key. The console key still opens the console.", "ok");
  }

  private toggle(args: string[]): void {
    const h = this.host;
    const cvar = args[0] ? findCvar(args[0]) : undefined;
    if (!cvar) return h.print(args[0] ? `Unknown setting "${args[0]}".` : "Usage: toggle <cvar> [a b ...]", "err");
    const cur = cvar.get(h.get());
    let next: string;
    if (args.length > 2) {
      // Source: the value after the current one (the first when the current one isn't listed).
      const vals = args.slice(1);
      const at = vals.findIndex((v) => {
        const r = parseCvar(cvar, v);
        return "value" in r && r.value === cur;
      });
      next = vals[(at + 1) % vals.length];
    } else if (cvar.bool) next = cur ? "0" : "1";
    else return h.print(`toggle ${cvar.name} needs the values to step through, e.g. toggle ${cvar.name} ${cvar.values ? cvar.values.slice(0, 2).join(" ") : "0 1"}.`, "err");
    let why: string | null = null;
    h.update((p) => (why = setCvar(p, cvar, next)));
    this.out(why ?? `${cvar.name} ${fmtCvar(cvar.get(h.get()))}`, why ? "err" : "ok");
  }

  private increment(args: string[]): void {
    const h = this.host;
    const cvar = args[0] ? findCvar(args[0]) : undefined;
    const [lo, hi, step] = args.slice(1, 4).map(Number);
    if (!cvar || ![lo, hi, step].every(Number.isFinite)) return h.print("Usage: incrementvar <cvar> <min> <max> <step>", "err");
    const cur = cvar.get(h.get());
    if (typeof cur !== "number") return h.print(`${cvar.name} isn't a number: use toggle ${cvar.name} …`, "err");
    let v = cur + step;
    if (v > hi + 1e-9) v = lo;
    if (v < lo - 1e-9) v = hi;
    let why: string | null = null;
    h.update((p) => (why = setCvar(p, cvar, String(Number(v.toPrecision(10))))));
    this.out(why ?? `${cvar.name} ${fmtCvar(cvar.get(h.get()))}`, why ? "err" : "ok");
  }

  /** `exec name`: a saved config (host_writeconfig) or none named: the list. */
  private exec(args: string[]): void {
    const h = this.host;
    const store = h.configs;
    if (!store) return this.out("Saved configs aren't available here.", "err");
    const name = configName(args[0] ?? "");
    if (!name) {
      const names = store.list();
      return this.out(names.length ? `Saved configs: ${names.join(", ")}. exec <name> loads one.` : "No saved configs. host_writeconfig <name> saves one.");
    }
    const text = store.get(name);
    if (text === null) return this.out(`No saved config "${name}". ${store.list().length ? `Saved: ${store.list().join(", ")}.` : "host_writeconfig <name> saves one."}`, "err");
    this.out(`Loading ${name}.cfg`, "dim");
    // Our own config: it's the whole setup, so this game's keys come from it too.
    this.paste(text, { keepOwn: false });
  }

  /** `host_writeconfig name` / `writecfg name`: the current setup as a Source config, saved here. */
  private writeConfig(args: string[]): void {
    const h = this.host;
    const store = h.configs;
    if (!store) return this.out("Saved configs aren't available here.", "err");
    const name = configName(args[0] ?? "config");
    if (!name) return this.out("Config names are letters, digits, - and _ (up to 32).", "err");
    const why = store.set(name, writeConfigText(h.get(), name));
    this.out(why ?? `Wrote ${name}.cfg. exec ${name} loads it.`, why ? "err" : "ok");
  }
}

/** A config name from `exec name.cfg` / `writecfg name`, or "" when it can't be one. */
export function configName(raw: string): string {
  const s = raw.trim().replace(/\.cfg$/i, "").toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(s) ? s : "";
}

/**
 * The whole setup as a Source config (host_writeconfig): unbindall, every bind, the aliases, every setting. exec of it
 * puts the same setup back (tested both ways).
 */
export function writeConfigText(p: Prefs, name: string, at = new Date()): string {
  const q = (s: string) => `"${s}"`;
  // A Source config line can't nest quotes: inner quotes go where they hold no ';' (say "gg" -> say gg); a command
  // that needs them can't be written, and says so in a comment.
  const flat = (t: string): string | null => {
    const v = t.replace(/"([^";]*)"/g, "$1");
    return v.includes('"') ? null : v;
  };
  const out = [`// bunnyhop.lol config "${name}", written ${at.toISOString().slice(0, 10)}`, "unbindall"];
  for (const [k, c] of Object.entries(p.aliases ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const v = flat(c);
    out.push(v === null ? `// alias ${k}: has quoted ";" (not written)` : `alias ${q(k)} ${q(v)}`);
  }
  // Action by action, keys in slot order (exec puts them back in the same slots), then the command binds.
  const binds: [string, string | null][] = [];
  for (const a of Object.keys(p.binds) as Action[]) for (const c of p.binds[a]) binds.push([keyForCode(c), commandForAction(a)]);
  for (const [c, t] of Object.entries(p.cmdBinds ?? {})) binds.push([keyForCode(c), flat(t)]);
  for (const [k, c] of binds) out.push(c === null ? `// bind ${k}: has quoted ";" (not written)` : `bind ${q(k)} ${q(c)}`);
  // Voice chat's push to talk key (its own pref: it can share a key with a solo bind).
  if (p.voice?.key) out.push(`bind ${q(keyForCode(p.voice.key))} "+voicerecord"`);
  for (const c of WRITTEN_CVARS) if (!c.skipWrite?.(p)) out.push(`${c.name} ${q(fmtCvar(c.get(p)))}`);
  return out.join("\n") + "\n";
}

/** unbindall: every key off every action, except the console key(s), so the console still opens. */
function unbindAllIn(b: Prefs["binds"]): void {
  for (const a of actions(b)) if (a !== "console") b[a] = [];
}

/**
 * What `bind <code> <command>` does: one action (an ordinary bind), a command line (a command bind), or why not. A
 * single say line is a command bind too: it goes through the chat, as typed.
 */
function bindPlan(code: string, command: string): { action: Action } | { command: string } | { error: string } {
  if (code === "Escape") return { error: "Esc always opens the menu; it can't be bound." };
  const c = command.trim();
  if (!c) return { error: "Nothing to bind." };
  if (c.length > COMMAND_MAX) return { error: `A bind can be ${COMMAND_MAX} characters long.` };
  const cmds = splitCommands(c);
  if (cmds.length === 1) {
    const a = actionForCommand(cmds[0]);
    if (a) return { action: a };
    const first = (tokenize(cmds[0])[0] ?? "").toLowerCase();
    if (UNSUPPORTED_COMMANDS[first]) return { error: `${first}: ${UNSUPPORTED_COMMANDS[first]}.` };
    if (/^slot([4-9]|10)$/.test(first)) return { error: `${first}: there are three weapon slots here.` };
    if (/^say(_team)?$/.test(first) && !argString(cmds[0]).trim()) return { error: "say needs a message: bind k \"say gg\"." };
  }
  return { command: cmds.join("; ") };
}

// ------------------------------------------------------------------------------------------------- config import

export interface ImportOptions {
  /** Keys bound to this game's own actions (restart, checkpoints, the jump toggle...) stay theirs. Default true. */
  keepOwn?: boolean;
}

export type ImportStatus = "set" | "bound" | "unbound" | "kept" | "skipped" | "error";
export interface ImportLine {
  command: string;
  status: ImportStatus;
  note: string;
}
export interface ImportReport {
  /** The settings with everything applied (a copy: nothing is written until the caller does). */
  prefs: Prefs;
  lines: ImportLine[];
  changed: boolean;
  binds: number;
  settings: number;
}

/**
 * A pasted config.cfg / autoexec.cfg against `base`: what it binds and sets, in order, on a copy. Unsupported lines
 * are listed with the reason (an unsupported bind keeps the key's current action). `unbindall` clears the keys
 * without asking (it's previewed), and with keepOwn leaves this game's own actions alone.
 */
export function importConfig(text: string, base: Prefs, o: ImportOptions = {}): ImportReport {
  const keepOwn = o.keepOwn ?? true;
  const p = JSON.parse(JSON.stringify(base)) as Prefs;
  const lines: ImportLine[] = [];
  let binds = 0;
  let settings = 0;
  const line = (command: string, status: ImportStatus, note = "") => lines.push({ command, status, note });
  /** Command binds made: checked at the end, once every alias in the file is known. */
  const chains: [number, string][] = [];
  for (const cmd of splitCommands(text)) {
    const words = tokenize(cmd);
    const name = (words[0] ?? "").toLowerCase();
    const args = words.slice(1);
    if (name === "bind") {
      const code = args[0] ? codeForKey(args[0]) : null;
      if (!code) {
        line(cmd, "error", args[0] ? `"${args[0]}" isn't a key name` : "no key");
        continue;
      }
      if (args.length < 2) {
        line(cmd, "skipped", "shows a bind, sets nothing");
        continue;
      }
      // Voice chat's push to talk: its own key pref (the key keeps any other bind it has).
      if (/^\+voicerecord$/i.test(args.slice(1).join(" ").trim())) {
        p.voice.key = code;
        binds++;
        line(cmd, "set", "push to talk");
        continue;
      }
      const plan = bindPlan(code, args.slice(1).join(" "));
      if ("error" in plan) {
        line(cmd, "skipped", plan.error.replace(/\.$/, ""));
        continue;
      }
      const owner = actionOfKey(p.binds, code);
      const r = "action" in plan ? plan.action : null;
      if (keepOwn && owner && owner !== r && ownAction(owner)) {
        line(cmd, "kept", `${keyForCode(code)} stays on ${commandForAction(owner)}`);
        continue;
      }
      if (!r && mixesMoveAndTurn((plan as { command: string }).command, p.aliases ?? {})) {
        line(cmd, "error", MOVE_TURN_REFUSAL.replace(/\.$/, ""));
        continue;
      }
      binds++;
      if (r) {
        bindAction(p, code, r);
        line(cmd, "bound", `${keyForCode(code)} → ${commandForAction(r)}`);
      } else {
        bindCommand(p, code, (plan as { command: string }).command);
        chains.push([lines.length, (plan as { command: string }).command]);
        line(cmd, "bound", `${keyForCode(code)} → ${(plan as { command: string }).command}`);
      }
    } else if (name === "unbind") {
      const code = args[0] ? codeForKey(args[0]) : null;
      if (!code || code === "Escape") {
        line(cmd, code ? "skipped" : "error", code ? "Esc always opens the menu" : "not a key name");
        continue;
      }
      const owner = actionOfKey(p.binds, code);
      if (keepOwn && owner && ownAction(owner)) {
        line(cmd, "kept", `${keyForCode(code)} stays on ${commandForAction(owner)}`);
        continue;
      }
      unbindIn(p, code);
      binds++;
      line(cmd, "unbound", keyForCode(code));
    } else if (name === "unbindall") {
      for (const a of actions(p.binds)) if (a !== "console" && !(keepOwn && ownAction(a))) p.binds[a] = [];
      if (!keepOwn) p.cmdBinds = {};
      binds++;
      line(cmd, "unbound", keepOwn ? "every Source key (this game's own keys and chat keys kept)" : "every key except the console's");
    } else if (name === "alias") {
      const n = (args[0] ?? "").toLowerCase();
      if (!ALIAS_NAME_RE.test(n) || findCvar(n) || COMMAND_NAMES.has(n)) {
        line(cmd, "error", n ? `"${args[0]}" can't be an alias name` : "no name");
        continue;
      }
      if (args.length < 2) {
        line(cmd, "skipped", "shows an alias, sets nothing");
        continue;
      }
      const body = argString(argString(cmd)).trim();
      if (body.length > COMMAND_MAX) {
        line(cmd, "error", "too long");
        continue;
      }
      const why = aliasMoveTurn(p, n, body);
      if (why) {
        line(cmd, "error", why.replace(/\.$/, ""));
        continue;
      }
      p.aliases = { ...p.aliases, [n]: body };
      binds++;
      line(cmd, "set", `alias ${n}`);
    } else if (findCvar(name)) {
      const c = findCvar(name)!;
      if (!args.length) {
        line(cmd, "skipped", "no value");
        continue;
      }
      const why = setCvar(p, c, args[0]);
      if (why) line(cmd, "error", why.replace(/\.$/, ""));
      else (settings++, line(cmd, "set", `${c.name} ${fmtCvar(c.get(p))}`));
    } else if (UNSUPPORTED_CVARS[name]) line(cmd, "skipped", UNSUPPORTED_CVARS[name]);
    else if (UNSUPPORTED_COMMANDS[name]) line(cmd, "skipped", UNSUPPORTED_COMMANDS[name]);
    else if (isServerCvar(name)) line(cmd, "skipped", "server setting");
    else if (name === "exec") line(cmd, "skipped", "paste that file's text too");
    else if (COMMAND_NAMES.has(name) || name === "echo" || name === "clear" || /^[+-]/.test(name)) line(cmd, "skipped", "not a setting");
    else line(cmd, "skipped", "unknown here");
  }
  for (const [i, text] of chains) {
    // Aliases defined later in the file can make a bind move and turn: not imported.
    const code = Object.keys(p.cmdBinds).find((c) => p.cmdBinds[c] === text && lines[i].note.startsWith(keyForCode(c) + " "));
    if (code && mixesMoveAndTurn(text, p.aliases ?? {})) {
      delete p.cmdBinds[code];
      binds--;
      lines[i] = { ...lines[i], status: "error", note: MOVE_TURN_REFUSAL.replace(/\.$/, "") };
      continue;
    }
    const unknown = unknownIn(text, p.aliases ?? {});
    if (unknown.length) lines[i].note += ` (${unknown.join(", ")} does nothing here)`;
  }
  const changed = JSON.stringify(p) !== JSON.stringify(base);
  return { prefs: p, lines, changed, binds, settings };
}

/** A report as console lines: the totals, then every line that didn't apply. */
export function reportLines(r: ImportReport): { text: string; kind: LineKind }[] {
  const out: { text: string; kind: LineKind }[] = [];
  const bad = r.lines.filter((l) => l.status === "skipped" || l.status === "error" || l.status === "kept");
  out.push({ text: `Imported ${r.binds} bind${r.binds === 1 ? "" : "s"} and ${r.settings} setting${r.settings === 1 ? "" : "s"}. ${bad.length ? `${bad.length} line${bad.length === 1 ? "" : "s"} not used:` : "Every line was used."}`, kind: r.changed ? "ok" : "out" });
  for (const l of bad) out.push({ text: `  ${l.command}  (${l.note})`, kind: l.status === "error" ? "err" : "dim" });
  if (r.changed) out.push({ text: "cfg_undo puts it back.", kind: "dim" });
  return out;
}

/** Defaults, for tests and Settings (what binds_default restores). */
export const defaultBinds = (): Prefs["binds"] => JSON.parse(JSON.stringify(DEFAULT_PREFS.binds));
export type { BindAction };
