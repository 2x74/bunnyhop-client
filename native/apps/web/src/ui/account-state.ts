import { appLocation } from "../platform/navigation";
import { desktopNoticePending } from "../platform/touch";
import { setPBAccount, syncPBs } from "../pb";
import { playerGlowRevision, setPlayerGlow } from "../player/cosmetics";
// The current player, cached for the page, plus a change signal so every account chip / panel repaints after a
// rename, sign-in or unlink. ui/account.ts re-exports these for older imports.

import { api, lastKnownMe, type Profile, type User } from "../api";
import { h } from "./dom";
import { avatarImg } from "./avatar";
import { setLoadout } from "../player/cosmetics";
import { loadoutFor } from "../loadout";
import { crownOf, heldRanks } from "../progression";

/** Opens the account panel (ui/account-panel.ts, loaded on demand with the name rules and blocklist). */
export function openAccount(section: "name" | "save" | null = null): void {
  void import("./account-panel").then((m) => m.openAccountPanel(section));
}

let replayIntro: (() => void) | null = null;
/** menu.ts registers how to reopen the intro; the account panel shows "Replay the intro" when set. */
export function setReplayIntro(fn: () => void): void {
  replayIntro = fn;
}
export const getReplayIntro = () => replayIntro;

/** Cheap pre-check before loading ui/onboarding.ts: false once this browser finished or skipped the intro. */
export const ONBOARDED_KEY = "bunnyhop:onboarded";
export function onboardingMaybeNeeded(): boolean {
  // The Wavedash build's keyboard-and-mouse notice on a phone comes first (platform/touch.ts).
  if (desktopNoticePending()) return false;
  return !localStorage.getItem(ONBOARDED_KEY) || appLocation().searchParams.get("intro") === "1";
}

export function accountAvatar(user: { name: string; avatarUrl: string | null }, size = 24): HTMLElement {
  const letter = () => h("span.avatar.avatar-initial", { "aria-hidden": "true" }, (user.name[0] ?? "?").toUpperCase());
  return user.avatarUrl ? avatarImg(user.avatarUrl, { cls: "avatar", px: size, letter, eager: true }) : letter();
}

/**
 * The current player (api.me() caches it for the page). A failed request never reads as "signed out": api.me() answers
 * with the last player this browser had and this re-checks in the background, repainting once an answer comes.
 */
export function me(): Promise<User | null> {
  if (!api.available()) return Promise.resolve(null);
  const epoch = accountEpoch;
  const p = api.me();
  void p.then((u) => {
    if (epoch !== accountEpoch) return;
    setPBAccount(u);
    if (!api.meStale()) void syncPBs();
    if (api.meStale()) recheckLater(u);
  });
  return p;
}

const RECHECK_MS = [5_000, 15_000, 60_000, 300_000];
let recheckTimer = 0;
let recheckStep = 0;
const sameAccount = (a: User | null, b: User | null) => a?.id === b?.id && a?.name === b?.name && a?.provider === b?.provider && a?.avatarUrl === b?.avatarUrl;

function recheckLater(shown: User | null): void {
  if (recheckTimer) return;
  recheckTimer = window.setTimeout(() => {
    recheckTimer = 0;
    void api.me().then((u) => {
      if (api.meStale()) {
        recheckStep = Math.min(recheckStep + 1, RECHECK_MS.length - 1);
        return recheckLater(shown);
      }
      recheckStep = 0;
      // Answered: repaint (a different player, or the same one whose level / profile couldn't load meanwhile).
      if (!sameAccount(shown, u)) cachedProfile = null;
      window.dispatchEvent(new Event(EVENT));
    });
  }, RECHECK_MS[recheckStep]);
}

let cachedProfile: Promise<Profile | null> | null = null;
/** When cachedProfile's GET /players/<me> went out, and api.writes() then (profileFor). */
let cachedAsk: { p: Promise<Profile | null>; at: number; writes: number } | null = null;
/** The signed-in player's profile (level, rank title, suggestions); null offline. Cached for the page once it loads. */
export function myProfile(): Promise<Profile | null> {
  if (cachedProfile) return cachedProfile;
  const glowRevision = playerGlowRevision();
  const p: Promise<Profile | null> = me()
    .then((u) => {
      // (After me(): a guest it just made is a write, but not one the profile could miss.)
      if (cachedAsk?.p === p) Object.assign(cachedAsk, { at: Date.now(), writes: api.writes() });
      return u ? api.profile(u.id) : null;
    })
    .catch(() => {
      if (cachedProfile === p) cachedProfile = null; // a failed load isn't kept: the next call tries again
      return null;
    });
  cachedProfile = p;
  cachedAsk = { p, at: Date.now(), writes: api.writes() };
  // Keep this device's knife / finish / gloves in step with the account (another device may have changed them).
  void p.then((prof) => {
    if (p !== cachedProfile) return;
    if (prof) for (const fn of profileListeners) fn(prof);
    if (glowRevision === playerGlowRevision()) setPlayerGlow(prof?.mine ? prof.player.playerGlow ?? null : null);
    if (prof?.mine) setLoadout(loadoutFor(prof.cosmetics, crownOf(heldRanks([prof.rank, ...prof.styles]))));
  });
  return p;
}
const profileListeners = new Set<(p: Profile) => void>();
/** Runs fn with every freshly loaded own profile (platform/hooks.ts: Wavedash's stats follow the verified totals). */
export function onMyProfile(fn: (p: Profile) => void): void {
  profileListeners.add(fn);
}

const REUSE_MS = 60_000;
/**
 * A player's profile for a screen (the profile, Stats). Your own reuses myProfile()'s GET /players/<me> (or the one in
 * flight) while it's under a minute old and nothing was written since, as a copy (screens edit theirs in place);
 * anyone else's, or an older one, is read fresh like before.
 */
export function profileFor(id: string): Promise<Profile> {
  const ask = cachedAsk;
  if (!ask || ask.p !== cachedProfile || lastKnownMe()?.id !== id || Date.now() - ask.at > REUSE_MS || ask.writes !== api.writes()) return api.profile(id);
  return ask.p.then((p) => (p?.mine && p.player.id === id ? structuredClone(p) : api.profile(id)));
}

/** Forget the cached profile (after a verified run). */
export function refreshMyProfile(): void {
  cachedProfile = null;
}

let accountEpoch = 0;
export function accountGeneration(): number { return accountEpoch; }
const EVENT = "bunnyhop:account";

/** Call after anything that changes the player (name, sign-in, unlink, sign-out): caches are dropped, views repaint. */
export function accountChanged(user?: User | null): void {
  accountEpoch++;
  setPBAccount(null);
  setPlayerGlow(null);
  if (user !== undefined) api.setMe(user);
  else api.forgetMe();
  cachedProfile = null;
  void me();
  window.dispatchEvent(new Event(EVENT));
  // The live third-person model follows own cosmetics even with every account panel closed.
  void myProfile();
}

/** Runs fn on every account change while `owner` is in the document. */
export function onAccountChange(owner: Element, fn: () => void): void {
  let seen = false;
  const handler = () => {
    if (!owner.isConnected) {
      if (seen) window.removeEventListener(EVENT, handler);
      return;
    }
    seen = true;
    fn();
  };
  requestAnimationFrame(() => (seen ||= owner.isConnected));
  window.addEventListener(EVENT, handler);
}
