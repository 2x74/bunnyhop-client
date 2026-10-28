import { registerChatCommand } from "../chat-commands";

export interface PaintCommands {
  place(): boolean;
  clear(): void;
  options(): void;
}
/** Commands are handled locally in both solo and rooms; no decals or settings go to the room server. */
export function registerPaintCommands(host: PaintCommands): () => void {
  const remove = [
    registerChatCommand({ name: "paint", help: "place a private paint mark", group: "more", key: "paint", where: "both",
      run: (ctx) => { if (!host.place()) ctx.reply("Paint is available while playing a map."); } }),
    registerChatCommand({ name: "clearpaint", help: "clear your paint", group: "more", key: "clearPaint", where: "both",
      run: (ctx) => { host.clear(); ctx.reply("Your paint has been cleared."); } }),
    registerChatCommand({ name: "paintoptions", aliases: ["paintcolour", "paintcolor", "paintsize"], help: "paint colour and size", group: "more", where: "both",
      run: () => host.options() }),
  ];
  return () => { for (const stop of remove) stop(); };
}
