/** Only navigation routes the web chat itself links. Never hand arbitrary chat
 * URLs to openExternal/OAuth/account actions. Mirror C++ safe_chat_target. */
export function safeNativeChatUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const match =
    /^https?:\/\/(?:www\.)?bunnyhop\.lol(\/(?:maps\/[A-Za-z0-9_.-]{1,128}|replay\/[A-Za-z0-9_-]{1,128}|u\/[A-Za-z0-9_-]{1,128}|\?(?:lobby|server)=[A-Za-z0-9_-]{1,64}))$/.exec(
      raw,
    );
  if (match && match[0] !== raw) return null;
  if (match && /^\/maps\/\.{1,2}$/.test(match[1])) return null;
  return match ? `https://bunnyhop.lol${match[1]}` : null;
}
