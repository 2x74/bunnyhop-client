import type { MenuMessage } from "./bridge";

/** Messages which replace the live map and therefore require leaving its room session first. */
export function leaveRoomBefore(message: MenuMessage): boolean {
  return message.type === "tutorial" && message.action !== "stop";
}
