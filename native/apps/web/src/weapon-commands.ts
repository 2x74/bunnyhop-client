// Weapon commands (physics v7, research/WEAPONS.md "Weapon commands"): bhoptimer's !usp / !glock / !knife, plus !gun
// <name> and the !guns menu for every gun we have. One place for the logic: chat, the key binds (main.ts:
// giveUsp, giveGlock, gunMenu) and the menu all call giveWeapon / openGunPicker; the chat commands go through the shared
// registry (chat-commands.ts, solo and rooms).
//
// A command only asks: the request goes into the next tick's buttons (input.ts requestGive) and the core does the rest
// (replace the slot, full clip, draw it; one per 10 ticks), so replays and the verifier see exactly what happened. The
// rule for ranked attempts is weapon-rules.ts: other guns are refused there with one line; in practice and on maps
// without ranked boards anything goes.
//
// A restart keeps your guns (weapon-rules.ts KeptWeapons): main.ts reports every tick's weapons (weaponsAfterTick) and
// every restart (weaponsAfterRestart), and asks for the kept guns again in the first commands after it
// (weaponsBeforeTick), like a typed !usp. From physics v10 those requests restore the gun: in hand without the draw,
// the USP's silencer as it was.

import { PHYSICS_V10, PHYSICS_V7, WEAPON_IDS, type WeaponReport } from "./core";
import type { Input } from "./input";
import type { RunSession } from "./session";
import { KeptWeapons, rankedCommandWeapon, weaponByName } from "./weapon-rules";
import type { MenuSpec, NumberMenu } from "./net/hud";
import { registerChatCommand, type ChatContext } from "./chat-commands";

export interface WeaponCommandHost {
  input: Input;
  session: RunSession;
  /** False while a command can't apply (spectating in a room, the replay viewer, noclip). */
  canGive?: () => boolean;
}

let host: WeaponCommandHost | null = null;
/** The guns the player gave themselves, given again after a restart. */
const kept = new KeptWeapons();

/** main.ts: once the session exists. */
export function initWeaponCommands(h: WeaponCommandHost): void {
  host = h;
}

/** Weapon commands work now: physics v7 and not spectating / in the replay viewer / in noclip. */
function commandsWork(h: WeaponCommandHost): boolean {
  return (h.session.settings.physics ?? 0) >= PHYSICS_V7 && (!h.canGive || h.canGive());
}

/** main.ts: after every live tick, with the core's weapon report (what the core gave, what was dropped). */
export function weaponsAfterTick(report: WeaponReport | null): void {
  kept.observe(report);
}

/**
 * main.ts: after every restart (R, !r, bonus / main, a start point, a room respawn, a style switch). The guns the
 * player gave themselves come back in the first commands of the new attempt, in the start zone before the timer can
 * start: only the USP, Glock and knife in a ranked attempt (weapon-rules.ts); any gun in practice. Physics v10: in hand
 * as they were (no draw, the silencer on if it was).
 */
export function weaponsAfterRestart(): void {
  if (!host) return;
  const { session } = host;
  if (!commandsWork(host)) return kept.cancel();
  const queued = kept.restarted(anyGunAllowed(session), (session.settings.physics ?? 0) >= PHYSICS_V10);
  // A practice gun on a ranked map keeps the new attempt practice, as when it's asked for by hand (giveWeapon).
  if (session.rankedMap && queued.some((id) => !rankedCommandWeapon(id))) session.freeGun = true;
}

/** main.ts: before each live command is sampled: a kept gun still to give goes into it (one per command cooldown). */
export function weaponsBeforeTick(): void {
  if (!host || !kept.queued || !commandsWork(host)) return;
  const give = kept.next();
  if (give) host.input.requestGive(give);
}

/** The guns in the menu, in key order: ours by name (viewmodel/guns/models), the knife last. */
export const PICKER: readonly { label: string; weapon: string }[] = [
  { label: "Cottontail", weapon: "usp" },
  { label: "Thumper", weapon: "glock" },
  { label: "Jackrabbit", weapon: "fiveseven" },
  { label: "Seed Drill", weapon: "p90" },
  { label: "Furrow", weapon: "ak47" },
  { label: "Broadfork", weapon: "m3" },
  { label: "Hedgerow", weapon: "xm1014" },
  { label: "Beanpole", weapon: "awp" },
  { label: "Knife", weapon: "knife" },
];

/** Whether this attempt may ask for any gun: practice, or a map without ranked boards. */
export function anyGunAllowed(s: RunSession): boolean {
  return s.unranked || !s.rankedMap;
}

/**
 * Asks for weapon `which` (a weapon id, or a name: "usp", "weapon_ak47", "Cottontail"). `say` shows the one line a
 * refusal needs (default: a HUD toast). Returns whether the request went in.
 */
export function giveWeapon(which: string | number, say?: (text: string) => void): boolean {
  if (!host) return false;
  const { session, input } = host;
  const tell = say ?? ((t: string) => session.hud.toast(t, 2500, "weapon-command"));
  const id = typeof which === "number" ? which : weaponByName(which);
  if (!id || !WEAPON_IDS[id]) {
    tell(`No gun called "${String(which).trim()}".`);
    return false;
  }
  if (host.canGive && !host.canGive()) return false;
  if ((session.settings.physics ?? 0) < PHYSICS_V7) return false;
  if (!rankedCommandWeapon(id)) {
    if (!anyGunAllowed(session)) {
      tell("Ranked runs only allow the USP, Glock and knife.");
      return false;
    }
    // Practice on a ranked map: the attempt stays practice until the next restart (session.ts freeGun).
    if (session.rankedMap) session.freeGun = true;
  }
  kept.cancel(); // the player's own command wins over a restart's
  input.requestGive(id);
  return true;
}

let menu: NumberMenu | null = null;
let keysHooked = false;

/** The guns menu is open (its digit keys pick). */
export function gunPickerOpen(): boolean {
  return !!menu?.open;
}

export function closeGunPicker(): void {
  menu?.hide();
}

/** Opens the guns menu (CS:S-style numbered list; 1-9 pick, 0 closes). Toggles it shut when already open. */
export async function openGunPicker(say?: (text: string) => void): Promise<void> {
  if (!host) return;
  if (menu?.open) return menu.hide();
  if (!menu) {
    const { NumberMenu } = await import("./net/hud");
    const root = document.getElementById("hud") ?? document.body;
    menu = new NumberMenu(root);
    menu.el.classList.add("gun-menu");
  }
  if (!keysHooked) {
    keysHooked = true;
    // Capture phase, ahead of the game's keys: while the menu is open its digits pick a gun instead of a weapon slot.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!menu?.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const d = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
        if (!d) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        menu.key(Number(d[1]));
      },
      true,
    );
  }
  const session = host.session;
  const any = anyGunAllowed(session);
  const spec: MenuSpec = {
    title: "Guns",
    items: PICKER.map((g) => {
      const id = (WEAPON_IDS as readonly string[]).indexOf(g.weapon);
      return { label: g.label, disabled: !any && !rankedCommandWeapon(id) };
    }),
    footer: any ? undefined : "Practice mode has every gun.",
    onPick: (i) => {
      menu?.hide();
      giveWeapon(PICKER[i].weapon, say);
    },
  };
  menu.show("guns", spec);
}

/**
 * Chat commands (chat-commands.ts; bhoptimer's names): !usp, !glock, !knife, !gun <name>, !guns. Solo and rooms; not
 * while spectating. main.ts registers them once.
 */
export function registerWeaponChatCommands(): void {
  const gate = (ctx: ChatContext) => !ctx.room?.spectating();
  for (const name of ["usp", "glock", "knife"] as const)
    registerChatCommand({
      name,
      help: `get the ${name === "knife" ? "knife" : name === "usp" ? "USP" : "Glock"}`,
      group: "guns",
      key: name === "usp" ? "giveUsp" : name === "glock" ? "giveGlock" : undefined,
      where: "both",
      run: (ctx) => void (gate(ctx) && giveWeapon(name, (t) => ctx.reply(t))),
    });
  registerChatCommand({
    name: "gun",
    aliases: ["give"],
    args: "<name>",
    help: "get a gun",
    about: "any of our guns by name (practice mode and unranked maps; ranked runs: USP, Glock, knife).",
    group: "guns",
    panelOnly: true,
    where: "both",
    run: (ctx, arg) => {
      if (!gate(ctx)) return;
      if (!arg) void openGunPicker((t) => ctx.reply(t));
      else giveWeapon(arg, (t) => ctx.reply(t));
    },
  });
  registerChatCommand({
    name: "guns",
    aliases: ["weapons"],
    help: "guns menu",
    group: "guns",
    key: "gunMenu",
    where: "both",
    run: (ctx) => void (gate(ctx) && openGunPicker((t) => ctx.reply(t))),
  });
}
