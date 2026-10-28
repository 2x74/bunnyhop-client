import { runChatLine, type ChatContext } from "../../web/src/chat-commands";
/** Shared web semantics: local actions stay private; help/unknown attempts are
 * logged privately by the room; only ordinary chat/server commands broadcast. */
export function dispatchNativeChat(
  text: string,
  context: ChatContext,
  send: (message: { t: "chat"; text: string; local?: true }) => boolean,
): void {
  const result = runChatLine(text, context);
  if (
    result !== "done" &&
    context.where === "room" &&
    !send({ t: "chat", text, ...(result === "log" ? { local: true as const } : {}) })
  )
    context.reply("The room is not connected.");
}
