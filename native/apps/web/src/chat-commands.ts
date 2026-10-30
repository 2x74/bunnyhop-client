// Chat commands (!r, !setstart, rtv, ...): one registry for solo chat (solo-chat.ts) and room chat (net/mp.ts). Both
// send every line they get through runChatLine(text, ctx); it runs the command or says what to do with the line.
// DOM-free (apps/api/test/chat-commands.test.ts runs it). !help, its topics and the "did you mean" suggestions are
// chat-help.ts; research/HELP.md has what players type and why the names below exist.
//
// Adding a command from another module (once, at load or from main.ts where the game objects live):
//
//   import { registerChatCommand } from "./chat-commands";
//
//   registerChatCommand({
//     name: "gun",                    // typed as !gun or /gun (or !sm_gun), any case
//     aliases: ["weapon"],            // optional: other names for it
//     args: "<name>",                 // optional: shown after the name in !help and the suggestions
//     help: "pick a gun",             // optional: a word or two (its row in Esc → Help, !help gun)
//     group: "guns",                  // optional: the !help line it's on (unlisted without one)
//     key: "gunMenu",                 // optional: the bind (ui/settings.ts Action) whose key !help shows next to it
//     where: "both",                  // "solo" | "room" | "both": where it works; elsewhere it answers one line
//     run: (ctx, arg, args) => {      // arg: the text after the name ("" if none), args: arg split on spaces
//       if (!arg) return ctx.reply("Usage: !gun <name>");
//       ...
//     },
//   });
//
// A handler that needs game objects closes over them (register where they live), or uses ctx.game (main.ts: keys,
// practice mode, styles, records). ctx has what the built-in commands use: reply(text) adds a local system line only
// you see (the way to answer a command), restart / start point calls, and ctx.room in rooms (null in solo).
// registerChatCommand throws if the name or an alias is taken, and returns a function that removes the command again.
//
// Rooms: the server also knows commands (rtv, nominate, timeleft, staff commands; apps/api/src/rooms/chat.ts
// parseCommand). Those are registered here with server: true and no handler, so rooms send the line as typed and solo
// play answers "Only in online servers". A handler can also return "send" to pass its line on to the room. Chat goes to
// the room. Unknown commands and !help are answered here; in rooms they also go to the room as "log" (the room's chat
// log keeps them, nobody sees them, and !help gets the staff lines from the room).

import { STYLE_DEFS, styleDef, type StyleId } from "./styles";
import { chatUsage, commandHelp, commandKey, helpLines, noTopic, suggestCommand, topicHelp, unknownCommand, worksIn } from "./chat-help";

export { chatUsage, commandKey, worksIn };

export type ChatWhere = "solo" | "room";

/** The !help line a command is listed on, in this order. */
export type HelpGroup = "run" | "practice" | "style" | "guns" | "server" | "more";

export interface ReplyOpts {
  /** Bold lead ("Practice") before the text: !help's group lines. */
  label?: string;
  /** Stays up longer than a chat line (help text to read). */
  long?: boolean;
}

export interface ChatContext {
  /** Where the line was typed. */
  readonly where: ChatWhere;
  /** A local system line in the chat log (only you see it). */
  reply(text: string, o?: ReplyOpts): void;
  /** Restart onto `track` (default: the current one), like R / M. */
  restart(track?: number): void;
  /** The next track (bonuses, then main), like B. */
  restartBonus(): void;
  /** Save / clear the start point (session.ts); they answer through reply. */
  setStartPoint(): void;
  clearStartPoint(): void;
  /** Room-only actions (net/mp.ts); null in solo play. */
  readonly room: RoomChat | null;
  /** The game behind the commands (main.ts); absent where there's none (tests). */
  readonly game?: ChatGame | null;
}

export interface RoomChat {
  spectating(): boolean;
  stopSpectating(): void;
  /** !spec <name>: spectate the player whose name starts with `name`; no name opens the spectate menu. */
  spectate(name: string): void;
  /** Toggles hiding the other players (!hide), or shows them (!show). */
  hidePlayers(toggle: boolean): void;
  toggleScores(): void;
  openNominateMenu(): void;
  /** Private lobbies (net/lobby.ts): copies the invite link (elsewhere: says how to make a lobby). */
  invite(): void;
  /**
   * !race [player] [style] [track] (net/race.ts): no argument opens the pick menus; else the player / style / track are
   * resolved here and sent to the room as "/race #slot style track"; "cancel" withdraws your challenge.
   */
  race(arg: string): void;
  /** Opens a gift preview; never spends credits from chat. */
  gift?(arg: string): void;
  /** !report [player] (social/commands.ts): the report form on a player in this room (their name), else the form asks. */
  report?(arg: string): void;
}

/** Practice from chat: practice mode, checkpoints, noclip (practice-mode/controller.ts command). */
export type PracticeCommand = "toggle" | "on" | "off" | "menu" | "noclip" | "save" | "tele" | "prev" | "next";

/** What main.ts gives the commands that need the live game. Same object in solo and rooms. */
export interface ChatGame {
  /** The first key bound to `action` (ui/settings.ts Action) as the game shows it ("Z", "Mouse4"), or null. */
  key(action: string): string | null;
  /** !practice, !noclip, !cp, ...: they answer through `reply` or the practice toasts. */
  practice(cmd: PracticeCommand, reply: (text: string) => void): void;
  /** The selected style (main track). */
  style(): StyleId;
  /** Switches style like the pause menu / F3 (restarts on the main track). */
  setStyle(id: StyleId): void;
  /** !wr / !pb for the current map, track and style. */
  record(kind: "wr" | "pb", reply: (text: string) => void): void;
}

export interface ChatCommand {
  /** Lower case, letters / digits / underscore. */
  name: string;
  aliases?: readonly string[];
  /** Arguments after the name, for !help and the suggestions ("<map>", "[player]"). */
  args?: string;
  /** A word or two: its row in Esc → Help and !help <command>. */
  help?: string;
  /** One line for !help <command> (default: `help`). */
  about?: string;
  /** The !help line it's on; unlisted without one. */
  group?: HelpGroup;
  /** A word after it on the !help line ("restart"). */
  brief?: string;
  /** In Esc → Help but not on the short !help line. */
  panelOnly?: boolean;
  /** The bind (ui/settings.ts Action) whose key !help shows next to it. */
  key?: string;
  /** A key that isn't a bind ("Tab", "N"), shown the same way. */
  fixedKey?: string;
  /** Where it works: elsewhere it answers one line instead (`elsewhere`, default "Only in online servers"). */
  where: ChatWhere | "both";
  /** The line it answers where it doesn't work. */
  elsewhere?: string;
  /** The room server handles it (apps/api/src/rooms): without a handler, rooms send the line as typed. */
  server?: boolean;
  /** Works typed alone without ! or / (SourceMod chat triggers like "rtv"), as the whole message. */
  bare?: boolean;
  /** A bare trigger that may carry one word ("nominate arcane"). */
  bareArg?: boolean;
  /** Not listed in !help or suggestions (staff commands). */
  hidden?: boolean;
  /** Runs the command. Return "send" (rooms) to also send the line to the room as typed. */
  run?: (ctx: ChatContext, arg: string, args: string[], line: ParsedChatLine) => void | "send" | "log";
}

export interface ParsedChatLine {
  /** Lower-cased command name as typed (may be an alias; without a SourceMod "sm_" prefix). */
  name: string;
  /** Text after the name, trimmed ("" if none). */
  arg: string;
  args: string[];
  /** "!" or "/", or "" for a bare trigger. */
  prefix: "!" | "/" | "";
}

/**
 * What the caller does with the line next: nothing ("done"), send it to the room as typed ("send"), or send it to the
 * room only for its chat log and staff help ("log": answered here already; net/protocol.ts chat `local`). Solo: always
 * "done".
 */
export type ChatResult = "done" | "send" | "log";

/** !invite <friend> (social/commands.ts sets it; this file stays DOM-free). */
let friendInvite: ((ctx: ChatContext, name: string) => void) | null = null;
export function setFriendInvite(f: typeof friendInvite): void {
  friendInvite = f;
}

const commands: ChatCommand[] = [];
const byName = new Map<string, ChatCommand>();

const NAME_RE = /^\w+$/;

/** Adds a command (see the top of this file). Throws if the name or an alias is taken. Returns an unregister function. */
export function registerChatCommand(c: ChatCommand): () => void {
  const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new Error(`chat command name "${n}": letters, digits and _ only`);
    if (byName.has(n)) throw new Error(`chat command "${n}" is already registered`);
  }
  if (!c.run && !c.server) throw new Error(`chat command "${c.name}" needs a handler`);
  const cmd: ChatCommand = { ...c, name: names[0], aliases: names.slice(1) };
  commands.push(cmd);
  for (const n of names) byName.set(n, cmd);
  return () => {
    const i = commands.indexOf(cmd);
    if (i < 0) return;
    commands.splice(i, 1);
    for (const n of names) byName.delete(n);
  };
}

/** The command `name` (or alias) is, or undefined. */
export function findChatCommand(name: string): ChatCommand | undefined {
  return byName.get(name.toLowerCase());
}

export function chatCommands(): readonly ChatCommand[] {
  return commands;
}

/** SourceMod's console names ("sm_noclip") typed in chat: the same command. */
const stripSm = (name: string): string => (name.length > 3 && name.startsWith("sm_") ? name.slice(3) : name);

/**
 * The command in a chat line, or null if it's chat. "!name args" and "/name args" as rooms always took them (any
 * case; the name is the word right after the prefix; "!sm_name" is "!name"). Without a prefix only registered bare
 * triggers count, and only as the whole message ("rtv", "nominate arcane"; "can we rtv" is chat), like the room
 * server's parseCommand.
 */
export function parseChatLine(text: string): ParsedChatLine | null {
  const t = text.trim();
  const m = /^([!/])(\w+)(?:\s+(.*))?$/.exec(t);
  if (m) {
    const arg = m[3]?.trim() ?? "";
    return { name: stripSm(m[2].toLowerCase()), arg, args: arg ? arg.split(/\s+/) : [], prefix: m[1] as "!" | "/" };
  }
  const b = /^([a-z]+)(?: ([\w.-]{1,64}))?$/i.exec(t);
  if (!b) return null;
  const c = findChatCommand(b[1]);
  if (!c?.bare || (b[2] && !c.bareArg)) return null;
  const arg = b[2] ?? "";
  return { name: b[1].toLowerCase(), arg, args: arg ? [arg] : [], prefix: "" };
}

export const ONLY_ROOMS = "Only in online servers.";
export const ONLY_SOLO = "Only in solo play.";
export const SOLO_SAY = "Chat isn't sent anywhere in solo. Type !help for commands.";

/**
 * Runs one chat line typed in `ctx.where`. Rooms: client commands run here; server commands and chat go to the room
 * ("send"); unknown commands are answered here (with the closest name) and go to the room's log ("log"). Solo:
 * commands run, room-only ones answer one line, unknown ones suggest, chat answers SOLO_SAY; never sends.
 */
export function runChatLine(text: string, ctx: ChatContext): ChatResult {
  const line = parseChatLine(text);
  const cmd = line ? findChatCommand(line.name) : undefined;
  if (!line) {
    if (ctx.where === "room") return "send";
    ctx.reply(SOLO_SAY);
    return "done";
  }
  if (!cmd) {
    ctx.reply(unknownCommand(line, suggestCommand(line.name, commands, ctx.where)));
    return ctx.where === "room" ? "log" : "done";
  }
  if (!worksIn(cmd, ctx.where)) {
    ctx.reply(cmd.elsewhere ?? (ctx.where === "solo" ? ONLY_ROOMS : ONLY_SOLO));
    return "done";
  }
  if (!cmd.run) return "send"; // server command, in a room
  const r = cmd.run(ctx, line.arg, line.args, line);
  return ctx.where === "room" && (r === "send" || r === "log") ? r : "done";
}

/**
 * Commands matching a partly typed "!na" / "/na" (name or alias prefix) that work in `where`, for the inline
 * suggestion: usages with the typed prefix. Empty once a space is typed, or for chat.
 */
export function suggestChat(text: string, where: ChatWhere, max = 5): string[] {
  const m = /^([!/])(\w*)$/.exec(text.trimStart());
  if (!m) return [];
  const q = stripSm(m[2].toLowerCase());
  const out: string[] = [];
  for (const c of commands) {
    if (c.hidden || !worksIn(c, where)) continue;
    const usage = `${m[1]}${c.name}${c.args ? ` ${c.args}` : ""}`;
    // (Not the command already typed out in full: nothing left to suggest.)
    if (usage.toLowerCase() !== `${m[1]}${q}` && [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(q))) out.push(usage);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Built-in commands. Rooms: these never reach the room, apart from the server ones and "nominate <map>".

const spectating = (ctx: ChatContext) => ctx.room?.spectating() ?? false;
const NO_GAME = "Not available here.";

/**
 * A practice command: practice answers (solo only; in rooms it says so, and the room's chat log keeps the attempt:
 * research/HELP.md found the confusion there).
 */
const practice =
  (cmd: PracticeCommand) =>
  (ctx: ChatContext): "log" | undefined => {
    if (!ctx.game) ctx.reply(NO_GAME);
    else if (spectating(ctx)) ctx.reply("You're spectating. !r to play.");
    else ctx.game.practice(cmd, (t) => ctx.reply(t));
    return "log";
  };

/** Switches to `id`, or says it's already the style. */
function switchStyle(ctx: ChatContext, id: StyleId): void {
  if (!ctx.game) return ctx.reply(NO_GAME);
  if (spectating(ctx)) return ctx.reply("You're spectating. !r to play.");
  if (ctx.game.style() === id) return ctx.reply(`Already ${styleDef(id)!.name}. !r restarts.`);
  ctx.game.setStyle(id);
}

/** bhoptimer's style commands (shavit-styles.cfg "command"), one per style, in menu order. */
export const STYLE_COMMANDS: Record<StyleId, readonly string[]> = {
  autohop: ["n", "nm", "normal"],
  legit: ["ez", "ezscroll", "easy"],
  scroll: ["scroll", "legit", "scr"],
  wonly: ["w", "wonly"],
  sideways: ["sw", "sideways"],
  hsw: ["hsw", "halfsideways"],
  lowgrav: ["lg", "lowgrav", "lowgravity"],
  // bhoptimer: "sr; seg; segment; segmented" (sr is also its !wr alias, so not here).
  segmented: ["seg", "segment", "segmented"],
  autostrafe: ["auto", "as", "autostrafe"],
};

/** The style a name means: an id, a name ("W-Only", "half sideways") or a style command ("hsw"). */
export function styleByName(q: string): StyleId | null {
  const k = q.toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return null;
  if (k === "legit") return "scroll"; // The legacy storage key now displays as EZ Scroll.
  for (const d of STYLE_DEFS) {
    const names = [d.id, d.name, d.short, d.brief, ...STYLE_COMMANDS[d.id]].map((n) => n.toLowerCase().replace(/[^a-z]/g, ""));
    if (names.includes(k)) return d.id;
  }
  return null;
}

const BUILT_IN: ChatCommand[] = [
  {
    name: "r",
    aliases: ["restart", "start"],
    help: "restart",
    about: "back to the start of this track.",
    group: "run",
    key: "restart",
    where: "both",
    run: (ctx) => (spectating(ctx) ? ctx.room!.stopSpectating() : ctx.restart()),
  },
  {
    name: "b",
    aliases: ["bonus"],
    help: "bonus",
    brief: "bonus",
    about: "the next bonus track, then back to the main track. !m goes straight to the main track.",
    group: "run",
    key: "restartBonus",
    where: "both",
    run: (ctx) => {
      if (spectating(ctx)) ctx.room!.stopSpectating();
      ctx.restartBonus();
    },
  },
  {
    name: "m",
    aliases: ["main"],
    help: "main track",
    brief: "main",
    about: "back to the main track.",
    group: "run",
    key: "restartMain",
    where: "both",
    run: (ctx) => {
      if (spectating(ctx)) ctx.room!.stopSpectating();
      ctx.restart(0);
    },
  },
  // Start point (start-point.ts), bhoptimer's names.
  {
    name: "setstart",
    aliases: ["ss", "setspawn"],
    help: "save start point",
    about: "stand still: restarts put you on that spot, facing the same way. In the start zone it's an ordinary start. Anywhere else (solo) restarts from it are practice, and the timer still starts from the start zone.",
    group: "run",
    key: "setStart",
    where: "both",
    run: (ctx) => {
      if (!spectating(ctx)) ctx.setStartPoint();
    },
  },
  {
    name: "clearstart",
    aliases: ["deletestart", "delstart", "ds", "clearspawn", "delspawn"],
    help: "clear start point",
    about: "restarts go back to the usual spot.",
    group: "run",
    panelOnly: true,
    key: "clearStart",
    where: "both",
    run: (ctx) => {
      if (!spectating(ctx)) ctx.clearStartPoint();
    },
  },
  // Practice (practice-mode/controller.ts command), bhoptimer's / KZ timers' names. Solo only: in rooms they say so. The
  // tools work in any attempt; a teleport or noclip makes it practice (practice-mode/attempt.ts).
  {
    name: "practice",
    aliases: ["prac"],
    help: "practice mode on / off",
    about: "every run is practice until you turn it off. Leaving clears this map's practice spawns and puts you back at the start.",
    group: "practice",
    key: "practice",
    where: "both",
    args: "[on|off]",
    run: (ctx, arg) => {
      const mode = arg.trim().toLowerCase();
      if (mode && mode !== "on" && mode !== "off") return ctx.reply("Use !practice [on|off]");
      return practice(mode === "on" || mode === "off" ? mode : "toggle")(ctx);
    },
  },
  {
    name: "noclip",
    aliases: ["nc", "noclipme"],
    help: "noclip",
    about: "fly through walls. The run becomes practice until you restart.",
    group: "practice",
    key: "noclip",
    where: "both",
    run: practice("noclip"),
  },
  {
    name: "cp",
    aliases: ["cps", "checkpoint", "checkpoints"],
    help: "checkpoint menu",
    about: "the checkpoint menu: save, teleport, previous / next, noclip. It stays open while you play; 0 or !cp closes it. While it's open, the checkpoint and noclip keys work during a run too.",
    group: "practice",
    where: "both",
    run: practice("menu"),
  },
  {
    name: "save",
    aliases: ["saveloc", "cpsave"],
    help: "save a checkpoint",
    about: "saves where you are, your speed and your timer. Your run carries on as before.",
    group: "practice",
    panelOnly: true,
    key: "cpSave",
    where: "both",
    run: practice("save"),
  },
  {
    name: "tele",
    aliases: ["tp", "teleport", "load", "gocheck", "loadloc"],
    help: "back to the checkpoint",
    about: "back to your last checkpoint. The run becomes practice until you restart.",
    group: "practice",
    key: "cpTeleport",
    where: "both",
    run: practice("tele"),
  },
  { name: "prevcp", aliases: ["prev"], help: "previous checkpoint", about: "back to the checkpoint before. The run becomes practice.", group: "practice", panelOnly: true, key: "cpPrev", where: "both", run: practice("prev") },
  { name: "nextcp", help: "next checkpoint", about: "forward to the next checkpoint. The run becomes practice.", group: "practice", panelOnly: true, key: "cpNext", where: "both", run: practice("next") },
  // No zone teleports: one line about what there is.
  { name: "end", aliases: ["goend"], where: "both", hidden: true, run: (ctx) => ctx.reply("No teleport to the end. !noclip gets you anywhere (solo), and the run becomes practice.") },
  // Styles (styles.ts): !style lists them or switches by name; bhoptimer's shortcuts switch straight away.
  {
    name: "style",
    aliases: ["styles"],
    args: "[name]",
    help: "pick a style",
    about: "lists the styles, or switches to one (!style hsw). Switching restarts the run.",
    group: "style",
    key: "cycleStyle",
    where: "both",
    run: (ctx, arg) => {
      if (!arg) {
        const now = ctx.game ? styleDef(ctx.game.style())?.name : null;
        return ctx.reply(`${STYLE_DEFS.map((d) => `!${STYLE_COMMANDS[d.id][0]} ${d.name}`).join(" · ")}${now ? `. Now: ${now}.` : ""}`, { long: true });
      }
      const id = styleByName(arg);
      if (!id) return ctx.reply(`No style "${arg}". Type !style for the list.`);
      switchStyle(ctx, id);
    },
  },
  ...STYLE_DEFS.map(
    (d): ChatCommand => ({
      name: STYLE_COMMANDS[d.id][0],
      aliases: STYLE_COMMANDS[d.id].slice(1),
      about: `${d.name}: ${d.rule.charAt(0).toLowerCase()}${d.rule.slice(1)}`,
      group: "style",
      where: "both",
      run: (ctx) => switchStyle(ctx, d.id),
    }),
  ),
  // Records (the API's board for this map, track and style; your PB from this browser).
  { name: "wr", help: "world record", about: "the world record on this map in your style.", group: "more", where: "both", run: (ctx) => (ctx.game ? ctx.game.record("wr", (t) => ctx.reply(t)) : ctx.reply(NO_GAME)) },
  { name: "pb", aliases: ["mytime"], help: "your best time", about: "your best time on this map in your style.", group: "more", where: "both", run: (ctx) => (ctx.game ? ctx.game.record("pb", (t) => ctx.reply(t)) : ctx.reply(NO_GAME)) },
  {
    name: "help",
    aliases: ["commands", "cmds"],
    args: "[topic]",
    where: "both",
    run: (ctx, arg) => {
      if (!arg) for (const l of helpLines(commands, ctx)) ctx.reply(l.text, { label: l.label, long: true });
      else for (const t of topicHelp(arg, ctx) ?? commandHelp(arg, commands, ctx) ?? [noTopic(arg)]) ctx.reply(t, { long: true });
      // Rooms: to the room's log; for a plain !help the room adds the staff commands for staff (rooms/room.ts).
      return "log";
    },
  },
  // The room server's (apps/api/src/rooms/room.ts command / admin).
  { name: "rtv", aliases: ["rockthevote"], help: "vote to change map", about: "rock the vote: enough votes start a map vote.", group: "server", where: "room", server: true, bare: true },
  {
    name: "nominate",
    args: "<map>",
    help: "nominate a map",
    about: "puts a map on the next vote (no name: a menu).",
    group: "server",
    where: "room",
    server: true,
    bare: true,
    bareArg: true,
    // No map: the menu. Typed bare (SourceMod's trigger) the line still goes to the room's chat; the server answers it.
    run: (ctx, arg, _args, line) => {
      if (arg) return "send";
      ctx.room!.openNominateMenu();
      return line.prefix ? undefined : "send";
    },
  },
  { name: "timeleft", help: "time left on this map", group: "server", panelOnly: true, where: "room", server: true, bare: true },
  { name: "nextmap", where: "room", server: true, bare: true },
  { name: "currentmap", where: "room", server: true, bare: true },
  { name: "thetime", where: "room", server: true, bare: true, hidden: true },
  { name: "motd", where: "room", server: true, bare: true, hidden: true },
  ...["kick", "ban", "unban", "mute", "unmute", "map", "mapvote", "extend"].map((name): ChatCommand => ({ name, where: "room", server: true, hidden: true })),
  // Rooms only, handled on the client.
  {
    name: "spec",
    aliases: ["spectate"],
    args: "[player]",
    help: "spectate",
    about: "watch a player (no name: a menu). !r to play again.",
    group: "server",
    fixedKey: "N",
    where: "room",
    elsewhere: "Spectating is for servers. Replays: Esc → Leaderboard → Watch.",
    run: (ctx, arg) => ctx.room!.spectate(arg),
  },
  { name: "hide", help: "hide other players", about: "hides the other players (again to show them).", group: "server", where: "room", run: (ctx) => ctx.room!.hidePlayers(true) },
  { name: "show", where: "room", hidden: true, run: (ctx) => ctx.room!.hidePlayers(false) },
  {
    name: "stop",
    aliases: ["respawn"],
    where: "room",
    hidden: true,
    run: (ctx) => ctx.room!.stopSpectating(), // (does nothing unless spectating)
  },
  { name: "scores", help: "scoreboard", group: "server", panelOnly: true, fixedKey: "Tab", where: "room", run: (ctx) => ctx.room!.toggleScores() },
  {
    name: "invite",
    args: "[friend]",
    help: "invite a friend",
    about: "invites a friend to this server or lobby (social/commands.ts). No name: copies a private lobby's invite link.",
    where: "room",
    run: (ctx, arg) => (arg && friendInvite ? friendInvite(ctx, arg) : ctx.room!.invite()),
  },
  { name: "gift", args: "[player name]", help: "gift Supporter", about: "opens a confirmation for a player with this exact full name. No name: gift to the room or choose random players. Credits are spent only after you confirm.", group: "server", where: "room", run: (ctx, arg) => ctx.room!.gift?.(arg) },

  // !race (apps/api/src/rooms/race.ts; research/RACE.md): resolved here (menus, names), run by the room.
  {
    name: "race",
    aliases: ["duel", "challenge"],
    args: "[player] [style] [main|bonus]",
    help: "race a player",
    about: "challenges a player on this map (no name: a menu). !accept · !decline · !forfeit · !race cancel · !race off / on.",
    group: "server",
    where: "room",
    elsewhere: "Races are for servers and private lobbies: Play online.",
    server: true,
    run: (ctx, arg) => ctx.room!.race(arg),
  },
  { name: "accept", aliases: ["acc"], help: "accept a race", about: "accepts the race challenge you got.", group: "server", panelOnly: true, where: "room", server: true },
  { name: "decline", aliases: ["deny"], help: "decline a race", about: "turns down the race challenge you got.", group: "server", panelOnly: true, where: "room", server: true },
  { name: "forfeit", aliases: ["surrender", "ff"], help: "give up a race", about: "gives up your race (the other racer wins), or withdraws your challenge.", group: "server", panelOnly: true, where: "room", server: true },
];

for (const c of BUILT_IN) registerChatCommand(c);
