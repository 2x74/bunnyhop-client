// Styles as rooms name them. Rooms relay every player's style, including ones this build can't play, and dropping a
// message over a style would freeze or hide everyone in it.
import { WIRE_STYLES } from "../../web/src/net/protocol";
import { styleLabel } from "../../web/src/styles";

/**
 * Styles the website plays that this build only shows. The vendored copy of the website predates Backwards (wire index
 * 10 since web 0.0.36); once a sync brings it in, the list below adds nothing.
 */
const SHOWN_ONLY_STYLES: readonly { id: string; name: string }[] = [{ id: "backwards", name: "Backwards" }];

/** The website's wire order (protocol.ts WIRE_STYLES: frozen, only appended to). */
export const ROOM_WIRE_STYLES: readonly string[] = [
  ...WIRE_STYLES,
  ...SHOWN_ONLY_STYLES.map((style) => style.id).filter((id) => !(WIRE_STYLES as readonly string[]).includes(id)),
];

export function roomStyleAt(index: number): string | null {
  return ROOM_WIRE_STYLES[index] ?? null;
}

/** A style's display name; one this build doesn't know reads as its id. */
export function roomStyleLabel(id: string): string {
  return SHOWN_ONLY_STYLES.find((style) => style.id === id)?.name ?? styleLabel(id);
}

/** A style id as rooms send it, known to this build or not. */
export function roomStyleId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

interface RoomSocketApi {
  roomSocketUrl(id: string, version: number, style: string): string;
}

/**
 * Room sockets say how many wire styles this build decodes (`wire=`, web api.ts roomSocketUrl since 0.0.36). Without
 * it the room treats the client as legacy: no live timer or style for Segmented, Infinite and Backwards players, and
 * Infinite and Backwards read as Normal. The vendored api.ts predates the parameter.
 */
export function announceRoomWireStyles(target: RoomSocketApi): void {
  const vendored = target.roomSocketUrl.bind(target);
  target.roomSocketUrl = (id, version, style) => {
    const url = new URL(vendored(id, version, style));
    url.searchParams.set("wire", String(ROOM_WIRE_STYLES.length));
    return url.toString();
  };
}
