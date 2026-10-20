// Weapon commands (physics v7; research/WEAPONS.md "Weapon commands"): the rule for which weapons a command may give
// where, the button bits that carry one, and the names players type. DOM-free and shared: the client
// (weapon-commands.ts) refuses what the rule doesn't allow, the verifier (verifier.ts) rejects a ranked replay that
// asked for it anyway.

import { WEAPON_EVENT_DROPPED, WEAPON_EVENT_GIVEN, WEAPON_IDS, type WeaponReport } from "./core";

/**
 * Weapons a command may give during a ranked attempt: what bhop servers offer (bhoptimer's sm_usp, sm_glock, sm_knife).
 * Practice attempts and maps without a ranked leaderboard may have any gun. Change this list to change the rule; the
 * client and the verifier both read it.
 */
export const RANKED_COMMAND_WEAPONS: readonly string[] = ["usp", "glock", "knife"];

/** Buttons bits 16..20: a weapon command's weapon id for one tick (crates/core game/weapons.rs IN_GIVE_*). */
export const IN_GIVE_SHIFT = 16;
export const IN_GIVE_MASK = 0x1f << IN_GIVE_SHIFT;
/**
 * Buttons bit 21 (physics v10): the weapon command restores a gun the player had before a restart (KeptWeapons): in hand
 * without the draw (crates/core game/weapons.rs IN_GIVE_RESTORE). The core honours it only on the first ticks after a
 * reset (WEAPON_RESTORE_TICKS); later, or before v10, the command is an ordinary one.
 */
export const IN_GIVE_RESTORE = 1 << 21;
/** Buttons bit 22 (physics v10, with IN_GIVE_RESTORE): the restored gun's +attack2 mode is on: the USP's silencer, burst. */
export const IN_GIVE_MODE = 1 << 22;
/** Every bit of a weapon command: what a command keeps when chat or spectating clears the player's input (mp.ts). */
export const IN_WEAPON_COMMAND_MASK = IN_GIVE_MASK | IN_GIVE_RESTORE | IN_GIVE_MODE;
/** The restore flags in a weapon command's value (input.ts requestGive: the bits from IN_GIVE_SHIFT up). */
export const GIVE_RESTORE = IN_GIVE_RESTORE >>> IN_GIVE_SHIFT;
export const GIVE_MODE = IN_GIVE_MODE >>> IN_GIVE_SHIFT;
/** Ticks between weapon commands the core accepts (bhoptimer's cooldown). */
export const WEAPON_COMMAND_COOLDOWN = 10;

/** The weapon id a command's buttons ask for (0 = none). */
export const givenWeapon = (buttons: number): number => (buttons & IN_GIVE_MASK) >>> IN_GIVE_SHIFT;
/** The weapon id of a weapon command value (input.ts requestGive), without the v10 restore flags. */
const givenWeaponId = (value: number): number => value & (IN_GIVE_MASK >>> IN_GIVE_SHIFT);

/** Whether a command may give weapon `id` (core.ts WEAPON_IDS index) in a ranked attempt. */
export const rankedCommandWeapon = (id: number): boolean => RANKED_COMMAND_WEAPONS.includes((WEAPON_IDS as readonly string[])[id] ?? "");

/**
 * The first command of a recording that asks for a weapon ranked runs don't allow, or null. Every weapon command in a
 * replay counts, also the ones the core ignored (within the cooldown): asking is the offence, the client never sends one.
 */
export function disallowedCommand(buttons: ArrayLike<number>): { tick: number; weapon: string } | null {
  for (let i = 0; i < buttons.length; i++) {
    const id = givenWeapon(buttons[i]);
    if (id && !rankedCommandWeapon(id)) return { tick: i, weapon: (WEAPON_IDS as readonly string[])[id] || `#${id}` };
  }
  return null;
}

const KNIFE_ID = 1;

/**
 * The guns a restart gives back (bhop servers: `!r` only resets the timer and moves you, a `!usp` stays with you). The
 * core resets to the knife on every restart, so the client remembers the guns the player last gave themselves by
 * command, one per slot, and asks for them again in the first commands of the new attempt, through the normal input
 * path: the replay records them like typed commands and the verifier re-simulates them the same way.
 *
 * - Remembered from the core's weapon reports (an accepted command: WEAPON_EVENT_GIVEN), not from what was asked, so a
 *   command the core ignored for its cooldown isn't remembered.
 * - `!knife` forgets them all (the knife is the default). A drop forgets that slot's gun. A map strip doesn't: the player
 *   didn't choose it, and the restart starts a new attempt.
 * - `restarted(anyGun)` queues them, oldest first, so the last one given is the one drawn. Without `anyGun` (a ranked
 *   attempt) only the guns ranked runs allow (RANKED_COMMAND_WEAPONS) come back; a practice gun stays remembered for
 *   the next practice attempt.
 * - One per WEAPON_COMMAND_COOLDOWN ticks from the first command after the restart (the core's cooldown resets with it).
 * - Physics v10 (`restarted(anyGun, true)`): the requests carry IN_GIVE_RESTORE, so each gun is in hand without the
 *   draw, and IN_GIVE_MODE when its +attack2 mode was on (the USP's silencer, the Glock's or FAMAS's burst), as last
 *   reported while it was out: a silenced USP comes back silenced, an unsilenced one unsilenced. Before v10 they are
 *   plain requests: a fresh gun, drawn, silencer off (attaching it again would cost the 1 s draw plus 3.08 s).
 */
export class KeptWeapons {
  /** Slot (1 primary, 2 secondary), weapon id and its +attack2 mode (silencer / burst on), oldest given first. */
  private kept: { slot: number; id: number; mode: boolean }[] = [];
  /** Weapon command values still to send (input.ts requestGive: the id and the v10 restore flags). */
  private queue: number[] = [];
  private wait = 0;
  private prev: WeaponReport | null = null;

  /** The remembered weapon ids, oldest first. */
  get weapons(): number[] {
    return this.kept.map((k) => k.id);
  }

  /** Whether each remembered gun's +attack2 mode is on (the USP's silencer, burst), in `weapons` order. */
  get modes(): boolean[] {
    return this.kept.map((k) => k.mode);
  }

  /** Weapon ids still to ask for after the last restart. */
  get pending(): number[] {
    return this.queue.map(givenWeaponId);
  }

  /** How many are still to ask for. */
  get queued(): number {
    return this.queue.length;
  }

  /** After every live tick: the core's weapon report (core.ts weaponReport). */
  observe(r: WeaponReport | null): void {
    if (!r) return;
    const prev = this.prev;
    this.prev = r;
    if (r.flags & WEAPON_EVENT_DROPPED && prev) {
      // The active gun went on the floor: its slot is empty now.
      this.kept = this.kept.filter((k) => (k.slot === 1 ? r.primary : r.secondary) !== 0 || (k.slot === 1 ? prev.primary : prev.secondary) === 0);
    }
    if (r.flags & WEAPON_EVENT_GIVEN) {
      if (r.active === KNIFE_ID) {
        this.forget();
        return;
      }
      const slot = r.primary === r.active ? 1 : r.secondary === r.active ? 2 : 0;
      if (slot) {
        this.kept = this.kept.filter((k) => k.slot !== slot);
        this.kept.push({ slot, id: r.active, mode: false });
      }
    }
    // The gun out's silencer / burst mode (it only changes while the gun is out; the report has the active gun's).
    const out = this.kept.find((k) => k.id === r.active && (k.slot === 1 ? r.primary : r.secondary) === r.active);
    if (out) out.mode = r.silencer || r.burst;
  }

  /** Forgets everything (and anything still queued). */
  forget(): void {
    this.kept = [];
    this.queue = [];
  }

  /** The player asked for a weapon themselves: what's still queued from the restart is dropped (theirs wins). */
  cancel(): void {
    this.queue = [];
  }

  /**
   * A restart (the core is back to the knife): queue the remembered guns this attempt may have. `anyGun`: practice, or
   * a map without ranked boards (weapon-commands.ts anyGunAllowed). `restore`: physics v10, the guns come back in hand
   * in their mode (IN_GIVE_RESTORE / IN_GIVE_MODE). Returns the queued ids.
   */
  restarted(anyGun: boolean, restore = false): number[] {
    this.prev = null;
    this.wait = 0;
    this.queue = this.kept
      .filter((k) => anyGun || rankedCommandWeapon(k.id))
      .map((k) => k.id | (restore ? GIVE_RESTORE | (k.mode ? GIVE_MODE : 0) : 0));
    return this.pending;
  }

  /** Once per live command, before it's built: the weapon command value to send in it (input.ts requestGive), or 0. */
  next(): number {
    if (this.wait > 0) {
      this.wait--;
      return 0;
    }
    const id = this.queue.shift() ?? 0;
    if (id) this.wait = WEAPON_COMMAND_COOLDOWN - 1;
    return id;
  }
}

/** Our names for the guns with a model of their own (viewmodel/guns/models), lower case, and their weapon ids. */
const OUR_NAMES: Record<string, string> = {
  cottontail: "usp",
  thumper: "glock",
  jackrabbit: "fiveseven",
  broadfork: "m3",
  hedgerow: "xm1014",
  "seed drill": "p90",
  seeddrill: "p90",
  furrow: "ak47",
  beanpole: "awp",
  carrot: "knife",
};

/** Other names CS:S players type (buy-menu aliases). */
const ALIASES: Record<string, string> = {
  km45: "usp",
  "9x19mm": "glock",
  glock18: "glock",
  "228compact": "p228",
  "228": "p228",
  deserteagle: "deagle",
  nighthawk: "deagle",
  dualies: "elite",
  elites: "elite",
  berettas: "elite",
  "57": "fiveseven",
  "five-seven": "fiveseven",
  fn57: "fiveseven",
  pump: "m3",
  "12gauge": "m3",
  autoshotgun: "xm1014",
  xm: "xm1014",
  mac: "mac10",
  mp: "tmp",
  mp5: "mp5navy",
  smg: "mp5navy",
  ump: "ump45",
  c90: "p90",
  defender: "galil",
  clarion: "famas",
  ak: "ak47",
  cv47: "ak47",
  m4: "m4a1",
  colt: "m4a1",
  krieg: "sg552",
  sg: "sg552",
  bullpup: "aug",
  schmidt: "scout",
  magnum: "awp",
  d3au1: "g3sg1",
  autosniper: "g3sg1",
  krieg550: "sg550",
  para: "m249",
  machinegun: "m249",
};

/** A typed weapon name (CS:S: "usp", "weapon_ak47", "deagle"; ours: "Cottontail", "Seed Drill") -> weapon id, or 0. */
export function weaponByName(name: string): number {
  let n = name.trim().toLowerCase().replace(/^weapon_/, "");
  n = OUR_NAMES[n] ?? ALIASES[n] ?? ALIASES[n.replace(/[\s_-]/g, "")] ?? n.replace(/[\s_-]/g, "");
  const id = (WEAPON_IDS as readonly string[]).indexOf(n);
  return id > 0 ? id : 0;
}
