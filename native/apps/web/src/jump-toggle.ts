// Hold jump (toggle) policy (input.ts setJumpToggle holds the jump; main.ts toggleJumpHold asks here first). DOM-free.
// The toggle only goes on where a held jump does something: styles with autohop (styles.ts StyleDef.autohop), and not
// in freecam (the body gets no input there). It goes off with releaseAll (focus, pointer lock: menus, chat, console)
// and on every restart (main.ts restart: R / B / M, style and map changes, start-zone track switches).

/** Why Hold jump (toggle) can't go on now, or null when it can. */
export function jumpHoldRefusal(o: { freecam: boolean; autohop: boolean; styleName: string }): string | null {
  if (o.freecam) return "Hold jump is off in freecam.";
  if (!o.autohop) return `${o.styleName} has no autohop: holding jump does nothing. Jump for each hop.`;
  return null;
}
