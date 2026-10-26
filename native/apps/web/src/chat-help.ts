// !help: the grouped lines, !help <topic | command>, and "did you mean" for unknown commands (chat-commands.ts runs
// them; the pause menu's Help tab shows the same groups, menu.ts helpPanel). DOM-free. The topics and names come from
// what players typed and asked in the room chat log: research/HELP.md.
//
// Keys are the player's own binds (ChatGame.key), never the defaults; an unbound action just shows the command.

import type { ChatCommand, ChatGame, ChatWhere, HelpGroup, ParsedChatLine } from "./chat-commands";

export const worksIn = (c: ChatCommand, where: ChatWhere): boolean => c.where === "both" || c.where === where;

/** "!name args" as !help and the suggestions show it. Bare server triggers ("rtv") without the prefix. */
export const chatUsage = (c: ChatCommand, prefix = "!"): string => `${c.bare && c.server ? "" : prefix}${c.name}${c.args ? ` ${c.args}` : ""}`;

/** The key shown next to a command: its bind's current key, or its fixed key. */
export const commandKey = (c: ChatCommand, ctx: { game?: Keys | null }): string | null => c.fixedKey ?? (c.key && ctx.game ? ctx.game.key(c.key) : null);

/** What the help needs: where it is, and the player's keys (ChatGame.key). */
export type Keys = Pick<ChatGame, "key">;
export interface HelpContext {
  where: ChatWhere;
  game?: Keys | null;
}
type Ctx = HelpContext;

export const GROUPS: readonly { id: HelpGroup; label: string; where?: ChatWhere }[] = [
  { id: "run", label: "Run" },
  { id: "practice", label: "Practice" },
  { id: "style", label: "Style" },
  { id: "guns", label: "Guns" },
  { id: "server", label: "Server", where: "room" },
  { id: "more", label: "More" },
];

/** A group's label here: practice is solo only, so rooms say so. */
export const groupLabel = (g: HelpGroup, where: ChatWhere): string => (g === "practice" && where === "room" ? "Practice (solo)" : GROUPS.find((x) => x.id === g)!.label);

/** The commands listed in group `g` for `where` (registration order). Practice is listed in rooms too (it says solo). */
export function groupCommands(all: readonly ChatCommand[], g: HelpGroup, where: ChatWhere): ChatCommand[] {
  return all.filter((c) => c.group === g && !c.hidden && (worksIn(c, where) || g === "practice"));
}

/** One item on a !help line: "!r (R) restart". Optional arguments are left out to keep the line short. */
function item(c: ChatCommand, ctx: Ctx): string {
  const key = commandKey(c, ctx);
  const args = c.args?.startsWith("<") ? ` ${c.args}` : "";
  return `${chatUsage({ ...c, args: undefined })}${args}${key ? ` (${key})` : ""}${c.brief ? ` ${c.brief}` : ""}`;
}

/** !help: one short line per group with the player's keys, then where to go next. */
export function helpLines(all: readonly ChatCommand[], ctx: Ctx): { label?: string; text: string }[] {
  const out: { label?: string; text: string }[] = [];
  for (const g of GROUPS) {
    if (g.where && g.where !== ctx.where) continue;
    const items = groupCommands(all, g.id, ctx.where)
      .filter((c) => !c.panelOnly)
      .map((c) => item(c, ctx));
    // The last line also says where the rest is.
    if (g.id === "more") items.push("!help <topic>", "Esc → Help");
    if (items.length) out.push({ label: groupLabel(g.id, ctx.where), text: items.join(" · ") });
  }
  return out;
}

/** Keys without a command, listed in Esc → Help with their group. */
const KEY_ROWS: readonly { group: HelpGroup; what: string; actions?: readonly string[]; fixed?: string; where?: ChatWhere }[] = [
  { group: "practice", what: "Turn left / right", actions: ["turnLeft", "turnRight"] },
  { group: "more", what: "Chat", fixed: "Y" },
  { group: "more", what: "Hide UI", actions: ["hideUi"] },
  { group: "more", what: "Third person (practice)", actions: ["thirdPerson"] },
];

export interface HelpRow {
  what: string;
  /** The player's key(s), or null if unbound / none. */
  key: string | null;
  /** The command(s) ("!noclip", "!n !scroll …"), or null for a key-only row. */
  cmd: string | null;
}

/**
 * Esc → Help (menu.ts): the same groups as !help, one row per command with its key, the style shortcuts on one row, and
 * the keys that have no command.
 */
export function helpPanelGroups(all: readonly ChatCommand[], ctx: Ctx): { label: string; rows: HelpRow[] }[] {
  const out: { label: string; rows: HelpRow[] }[] = [];
  for (const g of GROUPS) {
    if (g.where && g.where !== ctx.where) continue;
    const cmds = groupCommands(all, g.id, ctx.where);
    const rows: HelpRow[] = cmds.filter((c) => c.help).map((c) => ({ what: c.help!.charAt(0).toUpperCase() + c.help!.slice(1), key: commandKey(c, ctx), cmd: chatUsage(c) }));
    const plain = cmds.filter((c) => !c.help);
    if (plain.length) rows.push({ what: "Shortcuts", key: null, cmd: plain.map((c) => chatUsage(c)).join(" ") });
    for (const r of KEY_ROWS) {
      if (r.group !== g.id || (r.where && r.where !== ctx.where)) continue;
      const keys = r.fixed ?? (r.actions ?? []).map((a) => ctx.game?.key(a)).filter(Boolean).join(" ");
      if (keys) rows.push({ what: r.what, key: keys, cmd: null });
    }
    if (rows.length) out.push({ label: groupLabel(g.id, ctx.where), rows });
  }
  return out;
}

/**
 * The room server's !help for older clients (apps/api/src/rooms/room.ts): the same Server line current clients show,
 * built from the same registry so the two can't drift.
 */
export function roomHelpText(all: readonly ChatCommand[]): string {
  const cmds = groupCommands(all, "server", "room").filter((c) => !c.panelOnly);
  return `${groupLabel("server", "room")}: ${cmds.map((c) => item(c, { where: "room", game: null })).join(" · ")} · !help <topic> for more`;
}

/** "!x (key)" for topic text, from the registry's key for `action`. */
const k = (ctx: Ctx, cmd: string, action?: string): string => {
  const key = action && ctx.game ? ctx.game.key(action) : null;
  return key ? `${cmd} (${key})` : cmd;
};
const key = (ctx: Ctx, action: string, fallback: string): string => (ctx.game?.key(action) ?? null) || fallback;

interface Topic {
  names: readonly string[];
  lines: (ctx: Ctx) => string[];
}

const TOPICS: readonly Topic[] = [
  {
    names: ["practice", "prac", "noclip", "nc", "checkpoint", "checkpoints", "cp", "cps", "tele", "tp", "teleport", "save"],
    lines: (c) => [
      "Noclip and checkpoints work in any solo run. Saving a checkpoint changes nothing. A teleport or noclip makes the run practice: it is not submitted or saved as a PB until you restart.",
      `!cp opens the checkpoint menu · ${k(c, "!save", "cpSave")} · ${k(c, "!tele", "cpTeleport")} back · !prevcp / !nextcp · ${k(c, "!noclip", "noclip")}. During a run the teleport and noclip keys only work while !cp is open; typed commands always do. ${k(c, "!practice", "practice")} makes every run practice until you turn it off.`,
    ],
  },
  {
    names: ["styles", "style", "modes", "mode"],
    lines: (c) => [
      "!n Normal · !ez EZ Scroll · !scroll Legit Scroll · !w W-Only · !sw Sideways · !hsw Half-Sideways · !auto Auto-strafe",
      `${k(c, "!style", "cycleStyle")} lists them${c.game?.key("cycleStyle") ? ` (${c.game.key("cycleStyle")} cycles)` : ""}. Switching restarts the run; each style has its own leaderboard.`,
    ],
  },
  {
    names: ["start", "startpoint", "setstart", "spawn", "setspawn", "clearstart"],
    lines: (c) => [`${k(c, "!setstart", "setStart")}: stand still in the start zone and restarts put you on that spot, facing the same way. !clearstart goes back to the usual spot. Runs from it count.`],
  },
  {
    names: ["guns", "gun", "weapons", "weapon", "usp", "glock", "knife"],
    lines: (c) => [`${k(c, "!usp", "giveUsp")} · ${k(c, "!glock", "giveGlock")} · !knife · ${k(c, "!guns", "gunMenu")} menu · !gun <name>. Ranked runs allow the USP, Glock and knife; practice mode and unranked maps have every gun.`],
  },
  {
    names: ["bonus", "bonuses", "b"],
    lines: (c) => [`${k(c, "!b", "restartBonus")} goes to the next bonus and after the last one back to the main track, ${k(c, "!m", "restartMain")} straight to the main track. Bonuses have their own leaderboards and are always Normal style.`],
  },
  {
    names: ["bhop", "bunnyhop", "how", "strafe", "strafing", "speed", "jump", "tips"],
    lines: (c) => [
      `Hold ${key(c, "jump", "jump")} and keep holding it: you hop the moment you land. In the air, let go of ${key(c, "forward", "W")}.`,
      `Hold ${key(c, "left", "A")} while moving the mouse left, ${key(c, "right", "D")} while moving it right. Smooth, synced strafes gain speed. Esc → Learn to bhop has lessons; !auto strafes for you.`,
    ],
  },
  {
    names: ["server", "servers", "room", "rooms", "online", "vote"],
    lines: () => ["rtv votes for a new map · nominate <map> · timeleft · nextmap · !spec [player] or N watches someone · !race challenges someone · !hide hides players · Tab scoreboard · Y chat"],
  },
  {
    names: ["race", "races", "racing", "duel", "duels", "challenge"],
    lines: () => [
      "!race <player> [style] [main|bonus] challenges someone on this map (!race alone: a menu). !race off ignores challenges, !race on takes them again.",
      "!accept · !decline · !forfeit · !race cancel. Esc → Server → Race a player.",
    ],
  },
  {
    names: ["replays", "replay", "watch", "ghost", "ghosts"],
    lines: () => ["Every finished run has a replay: V right after it, or Esc → Leaderboard → Watch. In servers, !spec (N) watches a player live."],
  },
  {
    names: ["keys", "key", "binds", "bind", "controls", "settings"],
    lines: (c) => [
      [["restart", "restart"], ["restartBonus", "bonus"], ["setStart", "start point"], ["cycleStyle", "style"], ["thirdPerson", "third person"], ["hideUi", "hide UI"]]
        .map(([a, what]) => (c.game?.key(a) ? `${c.game.key(a)} ${what}` : null))
        .filter(Boolean)
        .concat(["Y chat"])
        .join(" · "),
      "Every key and command: Esc → Help. Change them in Settings → Keys.",
    ],
  },
];

export const helpTopics = (): readonly string[] => TOPICS.map((t) => t.names[0]);

/** !help <something that isn't a topic or command> ("!help 2"): the topics there are. */
export const noTopic = (arg: string): string => `No help for "${arg}". Topics: ${helpTopics().join(", ")}, or any command (!help noclip).`;

/** !help <topic>: its lines, or null if `topic` isn't one. */
export function topicHelp(topic: string, ctx: Ctx): string[] | null {
  const t = TOPICS.find((x) => x.names.includes(topic.toLowerCase().replace(/^[!/]/, "")));
  return t ? t.lines(ctx) : null;
}

/** !help <command>: one line about it, or null if there's no such (listed) command. */
export function commandHelp(name: string, all: readonly ChatCommand[], ctx: Ctx): string[] | null {
  const n = name.toLowerCase().replace(/^[!/]/, "").replace(/^sm_/, "");
  const c = all.find((x) => !x.hidden && (x.name === n || x.aliases?.includes(n)));
  if (!c) return null;
  const keyText = commandKey(c, ctx);
  const also = c.aliases?.length ? ` Also ${c.aliases.map((a) => chatUsage({ ...c, name: a, args: undefined })).join(", ")}.` : "";
  const what = c.about ?? c.help ?? "";
  const here = worksIn(c, ctx.where) ? "" : ` ${c.elsewhere ?? (c.where === "room" ? "Online servers only." : "Solo only.")}`;
  return [`${chatUsage(c)}${keyText ? ` (${keyText})` : ""}${what ? `: ${what}` : ""}${here}${also}`];
}

// ---------------------------------------------------------------------------------------------
// Unknown commands

/** Optimal string alignment distance (Levenshtein plus swapped neighbours: "nocilp" is one edit from "noclip"). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

const lexLess = (a: number[], b: number[]): boolean => {
  const i = a.findIndex((v, j) => v !== b[j]);
  return i >= 0 && a[i] < b[i];
};

/** How far off a typed name may be: one letter for short names, more for long ones. */
const allowed = (n: string): number => (n.length <= 4 ? 1 : n.length <= 8 ? 2 : 3);

/**
 * The listed command name (or alias) closest to `name`, as typed ("!noclp" → "noclip"), or null if none is close.
 * Commands that work here first; ties go to names that start with what was typed ("/c" → "cp"), then the shorter.
 */
export function suggestCommand(name: string, all: readonly ChatCommand[], where: ChatWhere): string | null {
  const n = name.toLowerCase();
  if (!n) return null;
  let best: { name: string; score: number[] } | null = null;
  for (const c of all) {
    if (c.hidden) continue;
    for (const cand of [c.name, ...(c.aliases ?? [])]) {
      const dist = editDistance(n, cand);
      if (dist > allowed(n)) continue;
      const score = [worksIn(c, where) ? 0 : 1, dist, cand.startsWith(n) ? 0 : 1, cand.length];
      if (!best || lexLess(score, best.score)) best = { name: cand, score };
    }
  }
  return best?.name ?? null;
}

/** The answer to an unknown command. */
export function unknownCommand(line: ParsedChatLine, suggestion: string | null): string {
  const p = line.prefix || "!";
  return suggestion ? `Unknown command ${p}${line.name}. Did you mean ${p}${suggestion}?` : `Unknown command ${p}${line.name}. Type !help for the list.`;
}
