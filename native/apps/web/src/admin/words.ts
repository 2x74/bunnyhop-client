// Moderation log rows in words: the action as a short past-tense phrase ("Muted", "Cleared a flag") and its details as
// one plain sentence ("30 min in us-east-1. Chat spam."), instead of codes and key: value chains. Unknown actions and
// keys fall back to readable text, so a new log action still reads.

import { minutesWord, when } from "./core";

/** [words, kind]: kind colours the word like a state (bad = destructive, ok = lifted, acc = staff, "" = plain). */
export const ACTION_WORDS: Record<string, [string, string]> = {
  kick: ["Kicked", "bad"],
  ban: ["Banned", "bad"],
  unban: ["Unbanned", "ok"],
  mute: ["Muted", "warn"],
  unmute: ["Unmuted", "ok"],
  map: ["Changed the map", ""],
  extend: ["Extended the map", ""],
  mapvote: ["Started a map vote", ""],
  rename: ["Renamed", ""],
  "ban-name": ["Banned a name", "bad"],
  "unban-name": ["Allowed a name again", "ok"],
  "block-term": ["Blocked a term", "warn"],
  "block-term-suggest": ["Suggested a blocked term", ""],
  "block-term-dismiss": ["Turned a term down", ""],
  "unblock-term": ["Unblocked a term", "ok"],
  "admin-add": ["Made an admin", "acc"],
  "admin-remove": ["Removed an admin", "acc"],
  "mod-add": ["Made a moderator", "acc"],
  "mod-remove": ["Removed a moderator", "acc"],
  verify: ["Verified", ""],
  unverify: ["Took Verified away", ""],
  "creator-set": ["Set a creator tag", ""],
  "creator-clear": ["Cleared a creator tag", ""],
  "badge-grant": ["Gave a badge", ""],
  "badge-revoke": ["Took a badge away", ""],
  "mapper-link": ["Linked a mapper", ""],
  "mapper-unlink": ["Unlinked a mapper", ""],
  "links-clear": ["Cleared profile links", "warn"],
  "avatar-block": ["Blocked a Discord avatar", "warn"],
  "avatar-unblock": ["Allowed a Discord avatar", "ok"],
  shadow: ["Shadowbanned", "warn"],
  unshadow: ["Lifted a shadowban", "ok"],
  "grant-wings": ["Gave the wings", ""],
  "revoke-wings": ["Took the wings away", ""],
  "network-ban": ["Banned a network", "bad"],
  "network-unban": ["Lifted a network ban", "ok"],
  "run-reverify": ["Re-verified a run", ""],
  "run-invalidate": ["Invalidated a run", "bad"],
  "integrity-clear": ["Cleared a flag", ""],
  "integrity-auto-close": ["Closed a shadowed player's flags", ""],
  "integrity-reopen": ["Reopened a flag", ""],
  "integrity-approve": ["Approved a rejected run", "warn"],
  "feedback-status": ["Changed a ticket", ""],
  "feedback-note": ["Noted a ticket", ""],
  "feedback-reply": ["Answered a ticket", ""],
  "player-message": ["Messaged", ""],
  "player-warn": ["Warned", "warn"],
  "broadcast-send": ["Sent an announcement", "acc"],
  "broadcast-stop": ["Stopped an announcement", ""],
  "supporter-grant": ["Made a supporter", ""],
  "supporter-revoke": ["Revoked supporter", "warn"],
  "supporter-amount": ["Changed a supporter total", ""],
  "map-tier": ["Changed a tier", "warn"],
  "map-retire": ["Retired a map", "warn"],
  "map-unretire": ["Put a map back", "ok"],
  "lobby-close": ["Closed a lobby", "bad"],
};

export const actionWords = (a: string): [string, string] => ACTION_WORDS[a] ?? [a.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), ""];

const cents = (v: unknown) => (typeof v === "number" ? `$${(v / 100).toFixed(v % 100 ? 2 : 0)}` : null);

/** The details JSON as one or two plain sentences. */
export function detailSentence(action: string, raw: string | null, room?: string | null): string {
  if (!raw && !room) return "";
  let d: Record<string, unknown> = {};
  try {
    d = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return raw ?? "";
  }
  const s = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : null);
  const where = room && room !== "*" ? ` in ${room}` : room === "*" ? " everywhere" : "";
  const reason = s("reason") ?? s("note");
  const parts: string[] = [];
  switch (action) {
    case "ban":
    case "mute":
      // minutes null = permanent; no minutes at all (older rows): just where.
      if ("minutes" in d) parts.push(`${d.minutes === null ? "Permanently" : `For ${minutesWord(d.minutes as number)}`}${where}.`);
      else if (where) parts.push(`${where.trim().replace(/^./, (c) => c.toUpperCase())}.`);
      break;
    case "map":
      if (s("map")) parts.push(`${s("from") ? `${s("from")} to ` : ""}${s("map")}${where}.`);
      break;
    case "extend":
      if (d.minutes) parts.push(`${s("map") ?? "The map"} by ${d.minutes} min${where}.`);
      break;
    case "rename":
      if (s("from")) parts.push(`${s("from")} to ${s("to") ?? "a default name"}.${d.reserve ? " The old name is banned." : ""}`);
      break;
    case "ban-name":
    case "unban-name":
      if (s("name")) parts.push(`"${s("name")}".${d.renamed ? ` Holder renamed to ${d.renamed}.` : ""}`);
      break;
    case "block-term":
    case "block-term-suggest":
    case "block-term-dismiss":
    case "unblock-term":
      if (s("term")) parts.push(`"${s("term")}"${d.whole ? ", whole word" : ""}.`);
      break;
    case "run-invalidate":
    case "run-reverify":
    case "integrity-clear":
    case "integrity-reopen":
    case "integrity-approve":
      if (s("map")) parts.push(`${s("map")}${s("style") && s("style") !== "autohop" ? ` ${s("style")}` : ""}${d.score !== undefined ? `, score ${d.score}` : ""}.`);
      break;
    case "integrity-auto-close":
      if (typeof d.flags === "number") parts.push(`${d.flags} open ${d.flags === 1 ? "flag" : "flags"}, ${s("note") ?? "already shadowed"}.`);
      break;
    case "badge-grant":
    case "badge-revoke":
      if (s("badge")) parts.push(`${s("badge")!.replace(/^./, (c) => c.toUpperCase())}.`);
      break;
    case "mapper-link":
    case "mapper-unlink":
      if (s("author")) parts.push(`${s("author")}.`);
      break;
    case "creator-set":
    case "creator-clear":
      parts.push(`${s("creator") ?? "none"}${s("was") ? ` (was ${s("was")})` : ""}.`);
      break;
    case "supporter-grant":
    case "supporter-amount":
      if (cents(d.cents ?? d.amountCents ?? d.to)) parts.push(`${cents(d.cents ?? d.amountCents ?? d.to)}.`);
      break;
    case "network-ban":
    case "network-unban":
      parts.push(`${s("kind") === "net" ? "Network" : s("kind") === "fp" ? "Fingerprint" : "Device"}${s("mode") ? `, ${s("mode") === "shadow" ? "shadow only" : "blocked"}` : ""}${d.days ? ` for ${d.days} days` : ""}.`);
      break;
    case "map-tier":
      parts.push(`${s("map")}: T${d.from ?? "?"} to T${d.to ?? "?"}.`);
      break;
    case "map-retire":
    case "map-unretire":
      if (s("map")) parts.push(`${s("map")}.`);
      break;
    case "lobby-close":
      parts.push(`${d.players ?? 0} sent out.`);
      break;
    case "feedback-status":
      if (s("status")) parts.push(`Now ${s("status")}.`);
      break;
    case "broadcast-send":
      if (s("subject")) parts.push(`"${s("subject")}".`);
      break;
    case "mod-add":
    case "admin-add":
    case "mod-remove":
    case "admin-remove":
      if (s("from")) parts.push(`Was ${s("from")}.`);
      break;
    default:
      if (where) parts.push(`${where.trim().replace(/^./, (c) => c.toUpperCase())}.`);
  }
  if (reason && !["feedback-note"].includes(action)) {
    const r = reason.replace(/^./, (c) => c.toUpperCase());
    parts.push(/[.!?]$/.test(r) ? r : `${r}.`);
  }
  if (typeof d.until === "number" && action !== "ban") parts.push(`Until ${when(d.until)}.`);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
