import { normalizeChatLine, runChatLine, type ChatContext } from "../../web/src/chat-commands";
/**
 * Shared web semantics: local actions stay private; help/unknown attempts are logged privately by the room; only
 * ordinary chat/server commands broadcast. A command typed with a Russian layout on ("!ызус") or a leading dot
 * (".rtv") runs as the command it stands for, and the room gets it in that form ("/rtv"), as web net/mp.ts sends it.
 */
export function dispatchNativeChat(
  typed: string,
  context: ChatContext,
  send: (message: { t: "chat"; text: string; local?: true }) => boolean,
): void {
  const text = normalizeChatLine(typed);
  const result = runChatLine(text, context);
  if (
    result !== "done" &&
    context.where === "room" &&
    !send({ t: "chat", text, ...(result === "log" ? { local: true as const } : {}) })
  )
    context.reply("The room is not connected.");
}
