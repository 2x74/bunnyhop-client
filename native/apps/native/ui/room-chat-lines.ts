// The lines the website's room client adds to chat itself (net/mp.ts onMessage and announce): who joined and left,
// gifts, records, the host handover, a kick or a refused join. The room sends only events for these; each client
// words them. Kinds and tones are net/hud.ts ChatLineOpts: "server" (» ...), "admin", "private" ((to you) ...),
// "local" and "announce" with a tone.
import type { Announcement, RoomInfo, ServerMsg } from "../../web/src/net/protocol";
import { formatTime } from "../../web/src/timer";
import { styleLabel } from "../../web/src/styles";
import { trackName } from "../../web/src/zones";

export interface RoomChatLine {
  kind: "server" | "admin" | "private" | "local" | "announce";
  text: string;
  /** announce: wr | sr | top10 | pb */
  tone?: string;
}

/** What the lines depend on, read before the message changes the room view. */
export interface RoomChatContext {
  you: number;
  youId: string | null;
  room: RoomInfo | null;
  host: number | null;
  changing: boolean;
  /** The chat bind's first key ("Y"), or null while it has none. */
  chatKey?: string | null;
}

const HOST_COMMANDS = "!map <map>, !mapvote, !extend, !kick <player>";

function welcomeLines(
  message: Extract<ServerMsg, { t: "welcome" }>,
  introduced: boolean,
  chatKey: string | null,
): RoomChatLine[] {
  const lines: RoomChatLine[] = [
    {
      kind: "local",
      text:
        `Connected to ${message.room.name} (${message.players.length}/${message.room.maxPlayers}) · ` +
        `${message.map.name}. ${chatKey ?? "Settings → Keys →"} chat · Tab scores · N spectate · type rtv / nominate / timeleft`,
    },
  ];
  if (!message.room.private || introduced) return lines;
  if (message.room.host === message.you)
    lines.push({
      kind: "local",
      text: `Your private lobby. Invite friends with !invite (copies the link) or Esc → Server. As host: ${HOST_COMMANDS}.`,
    });
  else lines.push({ kind: "local", text: "Private lobby. !invite copies the invite link." });
  return lines;
}

function giftLines(message: Extract<ServerMsg, { t: "gift" }>, youId: string | null): RoomChatLine[] {
  const names = message.names.join(", ");
  const more = message.count > message.names.length ? " and more" : "";
  const text =
    message.count === 1
      ? `${message.sender.name} gifted Supporter to ${names}!`
      : `${message.sender.name} gifted Supporter to ${message.count} players: ${names}${more}!`;
  const lines: RoomChatLine[] = [{ kind: "server", text }];
  if (youId && message.recipients.some((player) => player.id === youId))
    lines.push({ kind: "server", text: `You received Supporter from ${message.sender.name}. Enjoy your new perks!` });
  return lines;
}

/** A verified record or PB in the room (net/mp.ts announce). */
export function announceLine(a: Announcement): RoomChatLine {
  const style = a.style !== "autohop" ? ` (${styleLabel(a.style)})` : "";
  const where = `${a.map}${a.track ? ` ${trackName(a.track)}` : ""}`;
  const time = formatTime(a.time);
  const rank = a.rank ? ` · rank #${a.rank}` : "";
  const prev = a.prev ? ` (was ${formatTime(a.prev)})` : "";
  let text: string;
  if (a.kind === "wr") text = `★ NEW WORLD RECORD by ${a.name} on ${where}: ${time}${style}${prev}`;
  else if (a.kind === "sr") text = `${a.name} set a new server record on ${where}: ${time}${style}${rank}${prev}`;
  else if (a.kind === "top10") text = `${a.name} is now top 10 on ${where}: ${time}${style}${rank}`;
  else text = `${a.name} beat their PB on ${where}: ${time}${style}${rank}`;
  return { kind: "announce", tone: a.kind, text };
}

/**
 * The chat lines for one room message. `introduced`: this private lobby's intro was already shown (once per lobby,
 * as the website keeps it per tab).
 */
export function roomChatLines(message: ServerMsg, context: RoomChatContext, introduced = false): RoomChatLine[] {
  switch (message.t) {
    case "welcome":
      return welcomeLines(message, introduced, context.chatKey ?? null);
    case "join":
      if (message.quiet) return [];
      return [
        {
          kind: "server",
          text: `${message.player.name} joined${message.player.rank ? ` (${message.player.rank.name})` : ""}.`,
        },
      ];
    case "leave":
      if (message.quiet) return [];
      return [{ kind: "server", text: `${message.name} left${message.reason ? ` (${message.reason})` : ""}.` }];
    case "gift":
      return giftLines(message, context.youId);
    case "announce":
      return [announceLine(message.a)];
    case "host":
      if (message.slot !== context.you || context.host === context.you || context.changing) return [];
      return [{ kind: "local", text: `You're the host now: ${HOST_COMMANDS}.` }];
    case "kicked":
      return [{ kind: "admin", text: `Disconnected: ${message.reason}` }];
    case "error":
      return [{ kind: "private", text: message.message }];
    default:
      return [];
  }
}
