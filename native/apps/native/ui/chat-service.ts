import {
  protocolChatText,
  ChatStyleSwitch,
  ChatSuggestionFence,
  cycleSpectator,
  resolveRaceCommand,
} from "./chat-input";
import { dispatchNativeChat } from "./chat-routing";
import { NativeCopyStart } from "./copy-start";
import { api } from "../../web/src/api";
import {
  findChatCommand,
  normalizeChatLine,
  suggestChat,
  registerChatCommand,
  type ChatContext,
  type ReplyOpts,
} from "../../web/src/chat-commands";
import { registerSocialCommands } from "../../web/src/social/commands";
import { weaponByName } from "../../web/src/weapon-rules";
import { getPB } from "../../web/src/pb";
import { formatTime } from "../../web/src/timer";
import { copyLobbyInvite } from "../../web/src/net/lobby";
import { state, send } from "./bridge";
import { openGiftDialog } from "../../web/src/ui/gifting";
import { openReport } from "./report";
import { setNativeChatSink } from "./chat-hud";
import { registerStrafeTrainerCommand } from "./chat-features";
import { registerMapLookCommands } from "./map-looks";
import type { NativeRoomService } from "./room-service";

// Kept explicit so the host can validate actions without accepting arbitrary
// console commands or JS. The native host remains authoritative for all rules.
export type ChatAction =
  | {
      type: "chatAction";
      action:
        | "restart"
        | "restartBonus"
        | "setStart"
        | "clearStart"
        | "weapon"
        | "scores"
        | "hidePlayers"
        | "openRoom"
        | "jumpStats"
        | "showTriggers"
        | "showClips"
        | "freecam"
        | "spectateMenu"
        | "raceMenu"
        | "copyStartMenu"
        | "lookMenu";
      track?: number;
      weapon?: string;
      weaponId?: number;
      hidden?: boolean;
    }
  /** Features the host lists in `capabilities` (chat-features.ts). `on` absent: toggle. */
  | {
      type: "chatAction";
      action: "paint" | "clearPaint" | "paintOptions" | "measure" | "clearMeasure" | "lastLj" | "triggerMenu";
    }
  | { type: "chatAction"; action: "movementStat"; stat: "offsets" | "fjt" | "lj" | "jhud"; on?: boolean }
  /** The jump stats chat line on or off, and the least gain (0-100 %) a jump needs for a line. */
  | { type: "chatAction"; action: "ssjChat"; on: boolean; minGain?: number };
export interface NativeChatLine {
  type: "chatLine";
  text: string;
  name?: string;
  kind?: string;
  ms?: number;
  [key: string]: unknown;
}
export type NativeChatMessage =
  ChatAction | NativeChatLine | { type: "chatSuggestions"; items: string[]; request: number; input: string };
const emit = (value: NativeChatMessage) => send(value as unknown as Parameters<typeof send>[0]);

export type SsjCommand =
  { open: true } | { action: Extract<ChatAction, { action: "ssjChat" }>; reply: string } | { error: string };

/**
 * `!ssj [on|off|gain %]`, as the website's (ssj/index.ts): alone it opens the jump stats settings, on / off switch the
 * chat line, and a number turns the line on for jumps with at least that gain.
 */
export function ssjCommand(arg: string): SsjCommand {
  const value = arg.trim().toLowerCase().replace(/%$/, "");
  if (!value) return { open: true };
  if (value === "on" || value === "off") {
    const on = value === "on";
    return {
      action: { type: "chatAction", action: "ssjChat", on },
      reply: on ? "Jump stats on in chat." : "Jump stats off in chat.",
    };
  }
  const gain = Number(value);
  if (!/^\d+(\.\d+)?$/.test(value) || !(gain >= 0 && gain <= 100))
    return { error: "Usage: !ssj [on|off|gain %], e.g. !ssj 80" };
  const minGain = Math.round(gain);
  return {
    action: { type: "chatAction", action: "ssjChat", on: true, minGain },
    reply:
      minGain > 0 ? `Jump stats in chat: only jumps with ${minGain}% gain or more.` : "Jump stats in chat: every jump.",
  };
}

let registered = false;
export class NativeChatService {
  private hidden = false;
  private accountEpoch = 0;
  readonly copyStart: NativeCopyStart;
  private suggestions = new ChatSuggestionFence();
  constructor(
    private room: NativeRoomService,
    private openRoom: () => void,
  ) {
    this.copyStart = new NativeCopyStart({
      context: () => ({ map: state.map, style: state.style, track: state.track, loading: !!state.loading }),
      room,
      send,
      reply: (text) => this.reply(text),
    });
    this.copyStart.update();
    setNativeChatSink((text) => this.reply(text));
    if (!registered) {
      registered = true;
      registerSocialCommands();
      registerStrafeTrainerCommand();
      registerMapLookCommands(
        () => state.map,
        () => emit({ type: "chatAction", action: "lookMenu" }),
      );
      for (const weapon of ["usp", "glock", "knife"])
        registerChatCommand({
          name: weapon,
          where: "both",
          group: "guns",
          help: `get the ${weapon}`,
          run: (ctx) => {
            if (!ctx.room?.spectating())
              emit({ type: "chatAction", action: "weapon", weapon, weaponId: weaponByName(weapon) });
          },
        });
      registerChatCommand({
        name: "gun",
        aliases: ["give", "guns", "weapons"],
        where: "both",
        group: "guns",
        help: "get a weapon",
        args: "[name]",
        run: (ctx, arg) => {
          if (!arg) {
            emit({ type: "chatAction", action: "weapon", weapon: "menu" });
            return;
          }
          if (!weaponByName(arg)) return ctx.reply(`Unknown weapon "${arg}".`);
          if (!ctx.room?.spectating())
            emit({ type: "chatAction", action: "weapon", weapon: arg.slice(0, 64), weaponId: weaponByName(arg) });
        },
      });
      registerChatCommand({
        name: "ssj",
        args: "[on|off|gain %]",
        where: "both",
        group: "more",
        help: "jump stats",
        about:
          "speed, gain and sync on your 6th jump, as a chat line. !ssj opens its settings; !ssj on or off switches the line; !ssj 80 shows only jumps with 80% gain or more, !ssj 0 every jump.",
        run: (ctx, arg) => {
          const command = ssjCommand(arg);
          if ("open" in command) return emit({ type: "chatAction", action: "jumpStats" });
          if ("error" in command) return ctx.reply(command.error);
          emit(command.action);
          ctx.reply(command.reply);
        },
      });
      registerChatCommand({
        name: "jhud",
        args: "[on|off]",
        where: "both",
        group: "more",
        help: "jump hud",
        about:
          "speed and gain of every jump near the crosshair, coloured by how it went. !jhud opens its settings; !jhud on or off just switches it.",
        run: (ctx, arg) => {
          const value = arg.toLowerCase();
          if (!value) {
            emit({ type: "chatAction", action: "jumpStats" });
            return;
          }
          if (value !== "on" && value !== "off") return ctx.reply("Usage: !jhud [on|off]");
          emit({ type: "chatAction", action: "movementStat", stat: "jhud", on: value === "on" });
          ctx.reply(`JHUD ${value}. !jhud for its settings; Edit layout moves it.`);
        },
      });
      registerChatCommand({
        name: "showtriggers",
        aliases: ["showtrigger"],
        where: "both",
        group: "more",
        help: "show / hide triggers",
        about: "teleports, boosters, gravity and other triggers. Drawn only: runs with them on count as usual.",
        run: () => emit({ type: "chatAction", action: "showTriggers" }),
      });
      registerChatCommand({
        name: "showclips",
        aliases: ["showclip", "showplayerclips"],
        where: "both",
        group: "more",
        help: "show / hide player clips",
        about: "player clips and invisible walls. Drawn only: runs with them on count as usual.",
        run: () => emit({ type: "chatAction", action: "showClips" }),
      });
    }
  }
  resetAccount(): void {
    this.accountEpoch++;
    this.room.leave();
  }
  reply(text: string, opts?: ReplyOpts): void {
    emit({
      type: "chatLine",
      kind: "local",
      text: (opts?.label ? opts.label + ": " : "") + text,
      ms: opts?.long ? 30000 : 12000,
    });
  }
  suggest(value: unknown): void {
    const query = this.suggestions.take(value);
    if (query)
      emit({ type: "chatSuggestions", ...query, items: suggestChat(query.input, this.room.view.id ? "room" : "solo") });
  }
  submit(value: unknown): void {
    if (typeof value !== "string") return;
    const text = protocolChatText(value.trim());
    if (!text) return;
    if (!this.room.view.id && /^[!/]report(?:\s|$)/i.test(normalizeChatLine(text))) this.openRoom();
    const epoch = this.accountEpoch,
      reply = (text: string, opts?: ReplyOpts) => {
        if (epoch === this.accountEpoch) this.reply(text, opts);
      };
    // The host refuses a style during a gauntlet or while a map loads (and says why).
    const styleSwitch = new ChatStyleSwitch(
      () => state.style,
      (id) => {
        send({ type: "style", id });
        return !state.gauntlet.id && !state.loading;
      },
    );
    const player = (query: string) => {
      const q = query.trim().toLowerCase();
      return (
        this.room.view.players.find((p) => `#${p.slot}` === q || p.name.toLowerCase() === q) ??
        this.room.view.players.find((p) => p.name.toLowerCase().startsWith(q))
      );
    };
    const ctx: ChatContext = {
      where: this.room.view.id ? "room" : "solo",
      reply,
      restart: (track) => emit({ type: "chatAction", action: "restart", ...(track === undefined ? {} : { track }) }),
      restartBonus: () => emit({ type: "chatAction", action: "restartBonus" }),
      setStartPoint: () => emit({ type: "chatAction", action: "setStart" }),
      clearStartPoint: () => emit({ type: "chatAction", action: "clearStart" }),
      game: {
        key: (action) => state.settings.binds[action]?.[0] ?? null,
        copyStart: (arg, answer) => {
          void this.copyStart.command(arg, answer);
        },
        style: () => styleSwitch.style(),
        setStyle: (id) => styleSwitch.set(id),
        practice: (action) => send({ type: "practice", action }),
        // The website's !freecam / !fc / !freelook: the host flies the camera (freecam.hpp), or free look while watching.
        freecam: () => send({ type: "chatAction", action: "freecam" }),
        record: (kind, answer) => {
          if (!state.map) return answer("Load a map first.");
          if (kind === "pb") {
            const pb = getPB(state.map, state.style, state.track);
            answer(pb ? `Your PB: ${formatTime(pb.time)}` : "No PB yet.");
          } else
            void api.leaderboard(state.map, state.style, { track: state.track, limit: 1 }).then(
              (board) => {
                if (epoch !== this.accountEpoch) return;
                const top = board.entries[0];
                answer(top ? `WR: ${formatTime(top.time)} by ${top.player.name}` : "No record yet.");
              },
              () => answer("Couldn't load the leaderboard."),
            );
        },
      },
      room: this.room.view.id
        ? {
            spectating: () => this.room.view.players.find((p) => p.slot === this.room.view.you)?.spec != null,
            stopSpectating: () => {
              this.room.command({ t: "spec", target: null });
            },
            spectate: (query) => {
              if (!query) {
                emit({ type: "chatAction", action: "spectateMenu" });
                return;
              }
              const p = player(query);
              if (p && p.slot !== this.room.view.you) this.room.command({ t: "spec", target: p.slot });
              else reply(`No player "${query}".`);
            },
            hidePlayers: (toggle) => {
              this.hidden = toggle ? !this.hidden : false;
              emit({ type: "chatAction", action: "hidePlayers", hidden: this.hidden });
            },
            toggleScores: () => emit({ type: "chatAction", action: "scores" }),
            openNominateMenu: () => this.openRoom(),
            invite: () => {
              if (!this.room.view.room?.private) return reply("Create a private lobby to copy an invite link.");
              void copyLobbyInvite(this.room.view.id!).then((ok) =>
                reply(ok ? "Invite link copied." : "Couldn't copy invite link."),
              );
            },
            copyStart: (arg) => this.copyStart.roomCommand(arg, reply),
            race: (arg) => {
              // No name: the host's pick menus, as for a plain "!race" it catches itself.
              if (!arg) return emit({ type: "chatAction", action: "raceMenu" });
              const resolved = resolveRaceCommand(
                arg,
                this.room.view.players,
                this.room.view.you,
                state.style,
                state.bonusTracks,
              );
              if ("error" in resolved) return reply(resolved.error);
              this.room.command({ t: "chat", text: resolved.text });
            },
            report: (query) => {
              const p = query ? player(query) : null;
              this.openRoom();
              openReport(p ? { id: p.id, name: p.name } : query ? { name: query } : undefined);
            },
            gift: (arg) => {
              const p = arg ? player(arg) : null;
              if (arg && !p) return reply(`No player "${arg}".`);
              this.openRoom();
              openGiftDialog({
                roomId: this.room.view.id!,
                ...(p ? { recipientId: p.id, recipientName: p.name } : {}),
              });
            },
          }
        : null,
    };
    dispatchNativeChat(text, ctx, (message) => this.room.command(message));
  }
  control(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const { action, option } = value as { action: string; option?: number };
    if (action === "stop") {
      this.room.command({ t: "spec", target: null });
      return;
    }
    if (action === "vote" && Number.isInteger(option)) {
      this.room.command({ t: "vote", option });
      return;
    }
    if (action !== "next" && action !== "previous") return;
    const current = this.room.view.players.find((p) => p.slot === this.room.view.you)?.spec;
    const target = cycleSpectator(this.room.view.players, this.room.view.you, current, action === "next" ? 1 : -1);
    if (target !== null) this.room.command({ t: "spec", target });
  }
}
