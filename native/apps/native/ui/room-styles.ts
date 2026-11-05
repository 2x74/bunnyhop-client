// Styles as rooms name them. Rooms relay every player's style, including ones this build can't play, and dropping a
// message over a style would freeze or hide everyone in it.
import { WIRE_STYLES } from "../../web/src/net/protocol";
import { styleLabel } from "../../web/src/styles";

/** The website's wire order (protocol.ts WIRE_STYLES: frozen, only appended to). */
export const ROOM_WIRE_STYLES: readonly string[] = WIRE_STYLES;

export function roomStyleAt(index: number): string | null {
  return ROOM_WIRE_STYLES[index] ?? null;
}

/** A style's display name; one this build doesn't know reads as its id. */
export function roomStyleLabel(id: string): string {
  return styleLabel(id);
}

/** A style id as rooms send it, known to this build or not. */
export function roomStyleId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}
