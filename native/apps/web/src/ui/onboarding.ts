// First-visit onboarding, as a stage rather than a form: the bunny stands on the left over the live menu background,
// one question at a time sits on the right, and the bunny reacts to your answers (ui/onboarding-preview.ts).
//   name   "What should we call you?"  the name field (live checks, dice); your real name tag draws over the bunny as
//          you type, while it bhops on the spot; it flies out when the name is in. Or "Already play? Sign in".
//   look   "Pick a colour."  the colourways; a click recolours the bunny and it shows it off.
//   sens   "I play <game> at <n> with <n> DPI", converted to CS:S units, read back as cm per turn.
//   tutorial  "Have you bhopped before?"  Yes: the bunny crouches and jumps at the camera, the stage goes dark and
//          today's first map loads (ui/first-map.ts). No, teach me: "Start with the tutorial." with Learn to bhop, or
//          skip it and play that map anyway. The answer is kept (BHOPPED_KEY, and the server's "tutorial" step).
//   map    Only once that's answered (the intro replayed): "Hop in", with "Never bhopped? Learn first" under it.
// Nothing numbers the steps and there's no wizard footer: one primary button, a small Back from the second question,
// Enter on a filled-in answer moves on, Esc closes the whole thing. The question slides in (transform / opacity) as the
// bunny turns toward it.
// Returning players never see it (server users.onboarded_at, a local flag, or local play history). It can be replayed
// from the account panel (ui/account-panel.ts) or with ?intro=1.

import { WAVEDASH } from "../platform/env";
import { appHref, appLocation } from "../platform/navigation";
import { api, type User } from "../api";
import { achievement, COSMETICS, secretCosmetic, suggestNextMaps, supporterItem, unlockHint } from "../progression";
import { availableNow } from "./community";
import { getOutfit, knownOutfitUnlocks, rememberUnlocks, setOutfit } from "../player/cosmetics";
import { accountChanged, me, ONBOARDED_KEY } from "./account-state";
import { emailSignIn, reloadWithToast } from "./account-email";
import { nameField } from "./account-name";
import { toast } from "./account-panel";
import { arrowNav, h } from "./dom";
import { sfx } from "../audio";
import { fetchMapIndex } from "./maps";
import { firstMapOfTheDay } from "./first-map";
import { discoverPlayerContent } from "../content";
import { prefs } from "./settings";
import { cleanName, isDefaultName, suggestName } from "../moderation/names";
import { bunnyStage, type BunnyStage } from "./onboarding-preview";
import type { PlayerMarks } from "../creators";
import "./onboarding.css";
import { openTutorial, tutorialEnabled } from "../tutorial/entry";

const DONE_KEY = ONBOARDED_KEY;
/** "Have you bhopped before?": "yes" / "no", once answered (asked once per browser). */
export const BHOPPED_KEY = "bunnyhop:bhopped-before";

export function bhoppedBefore(): "yes" | "no" | null {
  try {
    const v = localStorage.getItem(BHOPPED_KEY);
    return v === "yes" || v === "no" ? v : null;
  } catch {
    return null;
  }
}

function rememberBhopped(v: "yes" | "no"): void {
  try {
    localStorage.setItem(BHOPPED_KEY, v);
  } catch {
    /* private mode */
  }
}

/** "tutorial" is the question (its server step key predates it); "map" the plain Hop in once it's been answered. */
type StepId = "name" | "look" | "sens" | "tutorial" | "map";

/** Mouse sensitivity in other games -> CS:S units (degrees per count: sens x yaw). */
export const GAMES: { id: string; label: string; yaw: number }[] = [
  { id: "cs", label: "CS2 / CS:GO / CS:S", yaw: 0.022 },
  { id: "source", label: "TF2 / Apex / other Source", yaw: 0.022 },
  { id: "valorant", label: "Valorant", yaw: 0.07 },
  { id: "overwatch", label: "Overwatch 2", yaw: 0.0066 },
  { id: "quake", label: "Quake Champions", yaw: 0.022 },
];
export const toCssSens = (sens: number, yaw: number) => Math.round(((sens * yaw) / 0.022) * 1000) / 1000;
export const cm360 = (sens: number, dpi: number) => (360 / (sens * 0.022) / Math.max(1, dpi)) * 2.54;

/** Played here before: any local trace of it. */
function hasLocalHistory(): boolean {
  if (localStorage.getItem("bunnyhop:last-map") || localStorage.getItem("bunnyhop:stats")) return true;
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith("bunnyhop:pb:")) return true;
  return false;
}

function markDone(): void {
  try {
    localStorage.setItem(DONE_KEY, String(Date.now()));
  } catch {
    /* private mode */
  }
}

export interface OnboardingHooks {
  /** Start a map (menu.ts pickMap). */
  pick: (map: string) => void;
}

let hooks: OnboardingHooks | null = null;

/** Without the menu's picker (replayed from the pause menu): load the map with a page navigation. */
function playMap(map: string): void {
  const u = new URL(location.origin + "/");
  u.searchParams.set("map", map);
  location.assign(u.toString());
}
let running = false;

/** Call once the home screen is up: shows the intro to first-time players, finishes ?signin= links, shows toasts. */
export async function maybeStartOnboarding(h0: OnboardingHooks): Promise<void> {
  hooks = h0;
  const forced = appLocation().searchParams.get("intro") === "1";
  if (forced) {
    const u = new URL(appHref());
    u.searchParams.delete("intro");
    history.replaceState(null, "", u);
    return openOnboarding();
  }
  if (localStorage.getItem(DONE_KEY)) return;
  if (hasLocalHistory()) return markDone();
  const user = await me();
  if (user?.onboarded) return markDone();
  // The Wavedash build asks nothing before the player's Wavedash account is signed in (the account remembers the intro).
  if (WAVEDASH && !user) return;
  if (appLocation().searchParams.has("map")) return; // deep link straight into a map: don't interrupt
  // A direct privacy request takes priority over the first-visit intro.
  if (document.querySelector("dialog.privacy-dialog[open]")) return;
  openOnboarding(user);
}


/** Opens the intro (first visit, or replayed from the account panel). */
export function openOnboarding(user?: User | null): void {
  if (running) return;
  running = true;
  let step = -1;
  let cleanup: (() => void) | null = null;
  const done: Partial<Record<StepId, boolean>> = {};
  // The last question: asked once (with the tutorial switched off there's nothing to offer: just Hop in).
  const STEPS: StepId[] = ["name", "look", "sens", tutorialEnabled() && !bhoppedBefore() ? "tutorial" : "map"];
  // The bunny's CS:S animations come with the player content, which a map's content manifest names: register it from
  // today's first map now, rather than once the menu background has loaded it, so the bunny hops with the game's
  // jump from the start (until then it uses the procedural fallback).
  void fetchMapIndex()
    .then((maps) => maps.find((m) => m.name === firstMapOfTheDay())?.sha256)
    .then((sha) => (sha ? discoverPlayerContent(sha) : false))
    .catch(() => undefined);

  // A full-screen dialog of our own (not account-panel's modal(): a click on its empty stage must not close it).
  const d = h("dialog.ob-dialog", { "aria-label": "Welcome to bunnyhop.lol" }) as HTMLDialogElement;
  d.addEventListener("keydown", (e) => e.stopPropagation());
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    finish();
  });
  d.addEventListener("close", () => {
    stage?.dispose();
    cleanup?.();
    d.remove();
    document.body.classList.remove("ob-open");
    running = false;
  });

  // ---- the stage: the bunny (or a plain disc without WebGL) and its name tag
  const art = h("div.ob-art");
  const fallbackTag = h("span.ob-tag-dom", { "aria-hidden": "true" });
  const outfitColor = () => COSMETICS.find((c) => c.id === getOutfit())?.color ?? "#ece5d8";
  const stage: BunnyStage | null = bunnyStage(art, { potato: document.body.classList.contains("potato") });
  if (!stage) art.append(h("div.ob-preview-off", { style: `--sw:${outfitColor()}` }, fallbackTag));
  stage?.setColor(outfitColor());
  const marks = (user ?? null) as unknown as PlayerMarks | null;
  const showName = (raw: string) => {
    const name = cleanName(raw);
    stage?.setName(name, marks);
    fallbackTag.textContent = name;
  };

  const q = h("div.ob-q");
  const fade = h("div.ob-fade", { "aria-hidden": "true" });
  d.append(art, h("div.ob-side", null, q), fade);

  /** The current question's primary action (Enter outside a field or button runs it too). */
  let primary: HTMLButtonElement | null = null;
  d.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key === "Enter" && primary && !primary.disabled && !(t instanceof HTMLInputElement) && !(t instanceof HTMLButtonElement) && !(t instanceof HTMLAnchorElement) && !(t instanceof HTMLSelectElement)) primary.click();
  });

  const save = (patch: { steps?: Partial<Record<StepId, boolean>>; done?: boolean }) => {
    if (api.available()) void api.saveOnboarding(patch).catch(() => undefined);
  };

  /**
   * Ends the intro. The last step's mark goes in the same save as "done": picking a map used to send the two at once,
   * and a step save landing second wiped "done" on the server (fixed there too: apps/api/src/account.ts saveOnboarding).
   */
  function finish(map?: string, last?: StepId): void {
    if (last) done[last] = true;
    markDone();
    save({ steps: done, done: true });
    if (d.open) d.close();
    if (map) (hooks?.pick ?? playMap)(map);
  }

  const complete = (id: StepId) => {
    done[id] = true;
    save({ steps: { [id]: true } });
  };

  /** Question `i` (`back`: coming back to it, from a later one or from its own second screen). */
  function go(i: number, back = i < step): void {
    if (i < 0 || i >= STEPS.length) return;
    const first = step < 0;
    cleanup?.();
    cleanup = null;
    step = i;
    const id = STEPS[i];
    show(id === "name" ? nameStep() : id === "look" ? lookStep() : id === "sens" ? sensStep() : id === "tutorial" ? bhopStep() : mapStep(), back ? -1 : 1, first);
  }

  /** Slides a view in, from the side it comes from (the bunny turns that way). */
  function show(view: HTMLElement, dir: 1 | -1, quiet = false): void {
    if (!quiet) {
      sfx(dir < 0 ? "ui_back" : "ui_confirm", 0.7);
      stage?.pivot(dir);
    }
    q.style.setProperty("--dir", String(dir));
    q.replaceChildren(view);
    q.classList.remove("in");
    void q.offsetWidth;
    q.classList.add("in");
  }

  /** The step's one primary button. */
  const primaryBtn = (label: string, onclick: () => void): HTMLButtonElement => (primary = h("button.btn.primary.ob-next", { type: "button", onclick }, label) as HTMLButtonElement);
  /** The primary button, with a small Back beside it from the second question on. */
  const actRow = (btn: HTMLElement) => h("div.ob-act", null, btn, step > 0 ? h("button.link-btn.ob-back", { type: "button", onclick: () => go(step - 1) }, "Back") : null);
  /** The last screens: quiet links under the big button(s), on their left edge (Back first). */
  const links = (...items: (HTMLElement | null)[]) => h("div.ob-links", null, h("button.link-btn.ob-quiet", { type: "button", onclick: () => go(step - 1) }, "Back"), ...items);
  const next = (id: StepId) => () => (complete(id), go(step + 1));

  // ---------------------------------------------------------------- name
  function nameStep(): HTMLElement {
    const start = user && !isDefaultName(user.name) ? user.name : suggestName();
    const nf = nameField({ initial: start, autofocus: true, onSaved: (u) => accountChanged(u ?? undefined), onInput: () => (showName(nf.input.value), stage?.typed()) });
    nf.input.setAttribute("aria-label", "Display name");
    // The bunny tilts its head while the name has a problem (the field marks it aria-invalid).
    const invalid = new MutationObserver(() => stage?.puzzled(nf.input.getAttribute("aria-invalid") === "true"));
    invalid.observe(nf.input, { attributes: true, attributeFilter: ["aria-invalid"] });
    // Until the name is in, the bunny bhops on the spot, strafing.
    stage?.strafe(true);
    cleanup = () => (invalid.disconnect(), stage?.puzzled(false), stage?.strafe(false));
    showName(start);
    // The dice fills the field without an input event of its own: follow it too.
    nf.el.querySelector(".nf-dice")?.addEventListener("click", () => showName(nf.input.value));
    requestAnimationFrame(() => nf.input.select());
    const btn = primaryBtn("Next", async () => {
      btn.disabled = true;
      const saved = await nf.save();
      btn.disabled = false;
      if (!saved) return void stage?.puzzled(true);
      showName(saved);
      complete("name");
      go(step + 1);
      stage?.fly();
    });
    nf.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") btn.click();
    });
    const signIn = h("div.ob-signin");
    const already = h(
      "button.link-btn.ob-quiet",
      {
        type: "button",
        onclick: async () => {
          already.remove();
          const providers = await api.providers().catch(() => ({ discord: false, email: false }));
          signIn.replaceChildren(
            ...[
              providers.discord ? h("a.btn.discord", { href: api.discordLoginUrl(appHref()) }, "Sign in with Discord") : null,
              providers.email
                ? emailSignIn({
                    onDone: (u, message) => {
                      // A returning player: skip the rest and reload as them. A new account: carry on from the bunny.
                      if (u.onboarded) {
                        finish();
                        return reloadWithToast(message);
                      }
                      accountChanged(u);
                      user = u;
                      showName(u.name);
                      toast(message);
                      go(1);
                    },
                  })
                : null,
            ].filter((x): x is HTMLElement => !!x),
          );
        },
      },
      "Already play? Sign in",
    );
    return h("section.ob-step.ob-name", null, h("h2.ob-h", null, "What should we call you?"), nf.el, actRow(btn), api.available() ? h("div.ob-alt", null, already, signIn) : null);
  }

  // ---------------------------------------------------------------- look
  function lookStep(): HTMLElement {
    const unlocked = knownOutfitUnlocks();
    // Not the owner's (role-held) colourways, nor rewards that can't be earned right now (ui/community.ts), nor the
    // Supporter set (no donation pitch in the first-visit intro), unless owned.
    const outfits = COSMETICS.filter(
      (c) => c.slot === "outfit" && ((c.unlock.kind !== "role" && !secretCosmetic(c) && !supporterItem(c) && (c.unlock.kind !== "achievement" || availableNow(achievement(c.unlock.id)))) || unlocked.has(c.id)),
    );
    const grid = h("div.ob-swatches", { role: "radiogroup", "aria-label": "Colour" });
    const caption = h("p.ob-caption", { "aria-live": "polite" });
    const paint = () => {
      const cur = getOutfit();
      for (const b of grid.querySelectorAll<HTMLButtonElement>("button")) {
        b.setAttribute("aria-checked", String(b.dataset.id === cur));
        b.classList.toggle("on", b.dataset.id === cur);
        b.tabIndex = b.dataset.id === cur ? 0 : -1;
      }
      caption.textContent = outfits.find((x) => x.id === cur)?.name ?? "";
    };
    // Only what you can wear now: the rest unlock by playing (the Loadout shows them with their goals).
    const addSwatch = (c: (typeof outfits)[number]) =>
      grid.append(
        h("button.ob-swatch", {
          type: "button",
          role: "radio",
          "data-id": c.id,
          "data-sound": "none",
          title: c.name,
          "aria-label": c.name,
          style: `--sw:${c.color}`,
          onclick: () => {
            setOutfit(c.id);
            if (api.available()) void api.saveCosmetics({ outfit: c.id }).catch(() => undefined);
            stage?.setColor(c.color ?? "#ece5d8");
            // The bunny shows it off (its own sounds, on its take-off and landing).
            if (stage) stage.show(c.id);
            else sfx("bunny_boing", 0.8);
            art.querySelector<HTMLElement>(".ob-preview-off")?.style.setProperty("--sw", c.color ?? "#ece5d8");
            paint();
          },
        }),
      );
    const wearable = (c: (typeof outfits)[number]) => c.unlock.kind === "free" || unlocked.has(c.id);
    outfits.filter(wearable).forEach(addSwatch);
    arrowNav(grid, "button");
    // Online: the account may have more unlocked (played on another device).
    if (api.available()) {
      void api
        .myCosmetics()
        .then((r) => {
          rememberUnlocks(r.unlocked);
          const shown = new Set([...grid.querySelectorAll<HTMLElement>("button")].map((b) => b.dataset.id));
          for (const c of outfits) if (!shown.has(c.id) && r.unlocked.includes(c.id)) addSwatch(c);
          paint();
        })
        .catch(() => undefined);
    }
    paint();
    return h("section.ob-step.ob-look", null, h("h2.ob-h", null, "Pick a colour."), grid, caption, actRow(primaryBtn("Next", next("look"))));
  }

  // ---------------------------------------------------------------- sensitivity
  function sensStep(): HTMLElement {
    const p = prefs.get();
    const game = h("select.ob-game", { "aria-label": "Game" }, ...GAMES.map((g) => h("option", { value: g.id }, g.label)));
    const theirs = h("input.ob-num", { type: "number", min: "0.01", max: "100", step: "0.01", value: String(p.sensitivity), "aria-label": "Your sensitivity in that game" });
    const dpi = h("input.ob-num", { type: "number", min: "100", max: "32000", step: "50", value: String(p.dpi), "aria-label": "Mouse DPI" });
    const result = h("p.ob-sens-result", { "aria-live": "polite" });
    // A new cm per turn: the bunny spins a 360 at that speed, once the typing settles.
    let shownCm = 0;
    let spinTimer = 0;
    const apply = () => {
      const g = GAMES.find((x) => x.id === game.value) ?? GAMES[0];
      const s = Number(theirs.value);
      const dp = Number(dpi.value);
      if (!(s > 0) || !(s < 1000)) return void (result.textContent = "Enter your sensitivity.");
      const css = Math.max(0.01, toCssSens(s, g.yaw));
      prefs.update((q) => {
        q.sensitivity = css;
        if (dp >= 100 && dp <= 32000) q.dpi = Math.round(dp);
      });
      const cm = Math.round(cm360(css, prefs.get().dpi));
      result.replaceChildren(h("b", null, String(cm)), " cm per turn");
      result.title = `${css} in CS:S units`;
      if (!shownCm) shownCm = cm;
      clearTimeout(spinTimer);
      if (cm !== shownCm) spinTimer = window.setTimeout(() => ((shownCm = cm), stage?.spin(cm)), 350);
    };
    cleanup = () => clearTimeout(spinTimer);
    for (const el of [game, theirs, dpi]) el.addEventListener("input", apply);
    for (const el of [theirs, dpi]) el.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && primary?.click());
    apply();
    return h(
      "section.ob-step.ob-sens",
      null,
      h("h2.ob-h.ob-sens-row", null, h("span", null, "I play"), game, h("span", null, "at"), theirs, h("span", null, "with"), dpi, h("span", null, "DPI")),
      result,
      actRow(primaryBtn("Next", next("sens"))),
    );
  }

  // ---------------------------------------------------------------- the way in
  /** The bunny crouches and jumps at the camera, the stage goes dark, today's first map loads. */
  const hopIn = async (btn: HTMLButtonElement, last: StepId) => {
    for (const b of q.querySelectorAll("button")) b.disabled = true;
    d.classList.add("launching");
    await stage?.launch(() => sfx("shine", 0.8));
    finish(firstMapOfTheDay(), last);
  };
  const learn = (last: StepId) => () => (finish(undefined, last), openTutorial(hooks?.pick));

  /** "Have you bhopped before?" Yes: straight into a map. No: the tutorial, or that map anyway. */
  function bhopStep(): HTMLElement {
    const answer = (v: "yes" | "no") => {
      rememberBhopped(v);
      complete("tutorial");
    };
    const yes = primaryBtn("Yes", () => {
      answer("yes");
      void hopIn(yes, "map");
    });
    yes.classList.add("ob-big");
    const no = h("button.btn.ob-big.ob-no", {
      type: "button",
      onclick: () => {
        answer("no");
        show(teachView(), 1);
      },
    }, "No, teach me") as HTMLButtonElement;
    requestAnimationFrame(() => yes.focus());
    return h("section.ob-step.ob-go", null, h("h2.ob-h", null, "Have you bhopped before?"), h("div.ob-choice", null, yes, no), links());
  }

  /** After "No, teach me": the tutorial first, or skip it. */
  function teachView(): HTMLElement {
    const btn = primaryBtn("Learn to bhop", learn("tutorial"));
    btn.classList.add("ob-big");
    const skip = h("button.link-btn.ob-quiet", { type: "button", onclick: () => void hopIn(skip as HTMLButtonElement, "map") }, `Skip, play ${firstMapOfTheDay()}`);
    requestAnimationFrame(() => btn.focus());
    const back = h("button.link-btn.ob-quiet", { type: "button", onclick: () => go(step, true) }, "Back");
    return h("section.ob-step.ob-go", null, h("h2.ob-h", null, "Start with the tutorial."), btn, h("div.ob-links", null, back, skip));
  }

  /** The intro replayed after the question was answered: Hop in, with the tutorial one quiet line under it. */
  function mapStep(): HTMLElement {
    const btn = primaryBtn("Hop in", () => void hopIn(btn, "map"));
    btn.classList.add("ob-big");
    requestAnimationFrame(() => btn.focus());
    // tutorial/flag.ts can switch the tutorial off.
    return h("section.ob-step.ob-go", null, btn, links(tutorialEnabled() ? h("button.link-btn.ob-quiet", { type: "button", onclick: learn("map") }, "Never bhopped? Learn first") : null));
  }

  document.body.append(d);
  document.body.classList.add("ob-open");
  d.showModal();
  go(0);
}

