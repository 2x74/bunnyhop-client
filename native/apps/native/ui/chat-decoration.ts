import { nameColorHex, staffBadgeOf, STAFF_LABEL, isCreatorKind, CREATOR_LABEL } from "../../web/src/creators";
import { hostMarks, hostNameLook, readMarks, type HostMark, type HostNameLook } from "./host-decoration";
/**
 * The chat line's name as the web draws it (net/hud.ts): `nativeName` (colour, effect, second colour) and
 * `nativeMarks` (host-decoration.ts). The text fields before them stay for hosts that draw words.
 */
interface ChatDecoration {
  nativeNameColor?: string;
  nativeBadge?: string;
  nativeRank?: string;
  nativeRankColor?: string;
  nativeCountry?: string;
  nativeProfileId?: string;
  nativeName?: HostNameLook;
  nativeMarks?: HostMark[];
}
export function nativeChatDecoration(value: Record<string, unknown>): ChatDecoration {
  const out: ChatDecoration = {};
  const color = nameColorHex(value.nameColor);
  if (color) out.nativeNameColor = color;
  const marks = readMarks({
    ...value,
    staff: value.staff ?? staffBadgeOf(value.role as Parameters<typeof staffBadgeOf>[0]),
  });
  const look = hostNameLook(marks);
  if (look.color || look.effect) out.nativeName = look;
  const markList = hostMarks(marks);
  if (markList.length) out.nativeMarks = markList;
  const badge =
    typeof value.staff === "string" && Object.hasOwn(STAFF_LABEL, value.staff)
      ? (value.staff as keyof typeof STAFF_LABEL)
      : staffBadgeOf(value.role as Parameters<typeof staffBadgeOf>[0]);
  const badges = [
    badge ? STAFF_LABEL[badge] : null,
    value.verified === true ? "Verified" : null,
    isCreatorKind(value.creator) ? CREATOR_LABEL[value.creator] : null,
    value.supporter === true ? "Supporter" : null,
    value.booster === true ? "Booster" : null,
  ].filter(Boolean);
  if (badges.length) out.nativeBadge = badges.join(" · ").slice(0, 96);
  if (value.rank && typeof value.rank === "object") {
    const name = (value.rank as { name?: unknown }).name;
    if (typeof name === "string") out.nativeRank = name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64);
    const rankColor = (value.rank as { color?: unknown }).color;
    if (typeof rankColor === "string" && /^#[0-9a-f]{6}$/i.test(rankColor)) out.nativeRankColor = rankColor;
  }
  if (typeof value.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)) out.nativeProfileId = value.id;
  if (typeof value.country === "string" && /^[a-z]{2}$/i.test(value.country))
    out.nativeCountry = value.country.toUpperCase();
  return out;
}
