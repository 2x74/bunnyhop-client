// Friends in chat (chat-commands.ts registry; research/FRIENDS.md): !msg / !reply to message a friend, !invite <friend>
// (the built-in !invite calls in here with a name), !send to share the map or your last run, !follow, !friends.
// Names resolve against your friends (exact, then prefix, then contains); !follow searches every chosen name. !report
// opens the feedback form's "Report a player" on someone (net/mp.ts resolves names in the room; elsewhere the server).

import { api, ApiError } from "../api";
import { openFeedback } from "../feedback/state";
import { registerChatCommand, setFriendInvite, type ChatContext } from "../chat-commands";
import { lastVerifiedRun } from "../ui/share";
import { whereText } from "./dock";
import { findFriend, friendsView, lastMessageFrom, myWhere, onlineFriends, playingMap, refreshFriends, setFollow, type MyWhere } from "./state";
import type { Friend } from "../api";

const err = (e: unknown) => (e instanceof ApiError ? e.message : "Couldn't reach the server");

/** One friend for `name`, or a reply saying why not. */
function pick(ctx: ChatContext, name: string): Friend | null {
  if (!friendsView()) return (ctx.reply("Friends are still loading."), null);
  const found = findFriend(name);
  if (found.length === 1) return found[0]!;
  if (!found.length) ctx.reply(`No friend called ${name}. Follow each other to be friends.`);
  else ctx.reply(`Which one: ${found.slice(0, 5).map((f) => f.name).join(", ")}?`);
  return null;
}

function sendText(ctx: ChatContext, f: Friend, body: string): void {
  void api.sendDm(f.id, { body }).then(
    (r) => ctx.reply(`To ${f.name}: ${r.message.body}`),
    (e) => ctx.reply(err(e)),
  );
}

const inGame = (w: MyWhere) => w.k === "server" || w.k === "lobby";

export function registerSocialCommands(): void {
  registerChatCommand({
    // (!w is the W-only style.)
    name: "msg",
    aliases: ["pm", "tell", "whisper", "dm"],
    args: "<friend> <message>",
    help: "message a friend",
    about: "sends a friend a message (they see it wherever they are). !reply answers the last one.",
    group: "more",
    where: "both",
    run: (ctx, _arg, args) => {
      const [name, ...rest] = args;
      if (!name || !rest.length) return ctx.reply("Usage: !msg <friend> <message>");
      const f = pick(ctx, name);
      if (f) sendText(ctx, f, rest.join(" "));
    },
  });
  registerChatCommand({
    name: "reply",
    aliases: ["re"],
    args: "<message>",
    help: "answer a friend",
    about: "answers the last friend who messaged you.",
    where: "both",
    run: (ctx, arg) => {
      const id = lastMessageFrom();
      const f = id ? friendsView()?.friends.find((x) => x.id === id) : null;
      if (!f) return ctx.reply("Nobody has messaged you yet.");
      if (!arg) return ctx.reply("Usage: !reply <message>");
      sendText(ctx, f, arg);
    },
  });
  registerChatCommand({
    name: "send",
    args: "<friend> map|run",
    help: "send a friend this map",
    about: "sends a friend this map, or your last verified run, as a card they can open.",
    where: "both",
    run: (ctx, _arg, args) => {
      const [name, what = "map"] = args;
      if (!name) return ctx.reply("Usage: !send <friend> map|run");
      const f = pick(ctx, name);
      if (!f) return;
      let m: { kind: "map" | "replay"; ref: string } | null = null;
      if (what === "map") {
        const map = playingMap()?.map;
        if (!map) return ctx.reply("Load a map first.");
        m = { kind: "map", ref: map };
      } else if (what === "run" || what === "replay" || what === "pb") {
        const run = lastVerifiedRun();
        if (!run) return ctx.reply("Finish a run first: your last verified run is what's sent.");
        m = { kind: "replay", ref: run };
      } else return ctx.reply("Usage: !send <friend> map|run");
      void api.sendDm(f.id, m).then(
        () => ctx.reply(`Sent ${f.name} ${m.kind === "map" ? m.ref : "your run"}.`),
        (e) => ctx.reply(err(e)),
      );
    },
  });
  registerChatCommand({
    name: "follow",
    aliases: ["unfollow"],
    args: "<player>",
    help: "follow a player",
    about: "follows a player by their full name; following each other makes you friends. !unfollow undoes it.",
    where: "both",
    run: (ctx, arg, _args, line) => {
      if (!arg) return ctx.reply(`Usage: !${line.name} <player>`);
      const on = line.name !== "unfollow";
      void api.searchPlayers(arg).then(
        async (players) => {
          const p = players.find((x) => x.name.toLowerCase() === arg.toLowerCase()) ?? (players.length === 1 ? players[0] : null);
          if (!p) return ctx.reply(players.length ? `Which one: ${players.slice(0, 5).map((x) => x.name).join(", ")}?` : `Nobody called ${arg}.`);
          const r = await setFollow(p.id, on, { who: p, quiet: true });
          ctx.reply(!r.ok ? r.error : !on ? `Unfollowed ${p.name}.` : r.friends ? `You and ${p.name} are friends now.` : `Following ${p.name}.`);
        },
        (e) => ctx.reply(err(e)),
      );
    },
  });
  registerChatCommand({
    name: "friends",
    help: "who's online",
    about: "lists your friends who are online and where they are.",
    group: "more",
    where: "both",
    run: (ctx) => {
      void refreshFriends().then(() => {
        const on = onlineFriends();
        if (!friendsView()?.friends.length) return ctx.reply("No friends yet. Follow someone from their profile; when they follow back you're friends.");
        if (!on.length) return ctx.reply("No friends online.");
        for (const f of on.slice(0, 8)) ctx.reply(`${f.name}: ${whereText(f.where, f.lastSeen)}`);
      });
    },
  });
  registerChatCommand({
    name: "report",
    args: "[player]",
    help: "report a player",
    about: "opens the report form on a player (in a server: their name as you see it). For cheating, or chat and names.",
    group: "server",
    panelOnly: true,
    where: "both",
    run: (ctx, arg) => {
      if (ctx.room?.report) return ctx.room.report(arg);
      openFeedback({ category: "report", ...(arg.trim() ? { report: { name: arg.trim() } } : {}) });
    },
  });
  setFriendInvite((ctx, name) => {
    const f = pick(ctx, name);
    if (!f) return;
    if (!inGame(myWhere())) return ctx.reply("Join a server or a lobby first.");
    void api.invite(f.id).then(
      () => ctx.reply(`Invited ${f.name}.`),
      (e) => ctx.reply(err(e)),
    );
  });
}
