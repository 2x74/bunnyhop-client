import { appLocation } from "../platform/navigation";
import { playerGlowControls } from "./player-glow-controls";
// The Support page (menu screen "support"; ui/nav.ts { screen: "support" }, /?support): supporting bunnyhop.lol (one-time
// payments through Stripe Checkout, src/stripe.ts in the API; "Coming soon" while the API has no Stripe key) and
// everything supporters get, to try on now. Opened from the main menu's footer, the pause menu's support link, the About
// page and any locked supporter item's "Supporter item" (loadout-view.ts goalText).
// One screen, no scrolling at desktop sizes; its tabs sit in the screen header (menu.ts passes the slot, as for the
// profile): perks, gifting previews, and Top supporters.
//
//   ┌ the ask (or the thanks) ───────┬ Knife  Finish  Gloves  Colourway  Hat  Ghost  Trail ────────────┐
//   │ two short lines, the amount    │ the Loadout's own stage (ui/loadout-view.ts  │ the slot's item    │
//   │ and the Support button         │ in preview mode, supporter items only: drag  │ from each set      │
//   │ your card in each set, fanned  │ to turn; nothing is equipped or saved),      │ Your name | Your   │
//   │ (the picked one in front),     │ dressed and lit in the picked set; trying an │ card: the name and │
//   │ the sets' names under it       │ item on picks its set                        │ card looks         │
//   │                                │                                              │ player glow        │
//   │ the other perks in a sentence  │                                              │                    │
//   └────────────────────────────────┴──────────────────────────────────────────────┴────────────────────┘
//
// A supporter (GET /me/supporter: a payment or an admin's grant) gets a thank-you and links to their Loadout and Edit card
// instead, and their "Show me in Top supporters" switch on that tab. The previews follow the game's settings: Potato
// mode holds the animated ones still (viewmodel/finishes/shader.ts setCosmeticsStill), reduced motion stops the name
// effects (ui/marks.css), and both hold the decorations, borders and card effects still (avatar-deco.css, card-fx.css).

import { WAVEDASH } from "../platform/env";
import { wavedashCopy } from "../platform/wavedash";
import "./support.css";
import { api, lastKnownMe, type MySupport, type Profile, type TopSupporter, type User } from "../api";
import { NAME_COLORS, peakOf, type NameColorId } from "../creators";
import { askOf, supportStatus } from "../support-ask";
import { lookSaver, PREVIEW_LOOK, savedPicks, type LookPicks } from "../support-look";
import { nameStyleShown } from "../supporter-looks";
import { COSMETICS, cosmetic, DEFAULT_COSMETICS, supporterItem, SUPPORTER_MIN_USD, SUPPORTER_SETS, type SupporterSetId } from "../progression";
import { UNRANKED } from "../ranking";
import { uiSound } from "../audio/ui";
import { getLoadout, getPlayerGlow, playerGlowRevision, setPlayerGlow } from "../player/cosmetics";
import { discordLink } from "./community";
import { me, myProfile, openAccount, accountGeneration, onAccountChange } from "./account-state";
import { playerCard, type SupporterLook } from "./card";
import { h } from "./dom";
import { hopIndicator } from "./hop";
import { loadoutView, type LoadoutChoice, type LoadoutModel } from "./loadout-view";
import { nameAttrs, supporterMark } from "./marks";
import { navigate } from "./nav";
import { scrollCue } from "./scroll-cue";
import { profileWriteGuard } from "./profile-write";
import { supportGifting } from "./support-gifting";
import { borderChoices, cardEffectChoices, cardFxSwatch, COLOUR_CHOICES, DECO_CHOICES, decoSwatch, EFFECT_CHOICES, FONT_CHOICES, HOVER_FX_CHOICES, hoverFxSwatch, nameSample, styleChoices } from "./supporter-pickers";

/**
 * Back from Stripe's payment page (/?support=thanks, src/stripe.ts success_url): read at load, before menu.ts tidies the
 * address, and used once. The webhook that makes the player a supporter usually lands within seconds; until it does the
 * page says the payment went through and checks again.
 */
let backFromCheckout = appLocation().searchParams.get("support") === "thanks";
/** How long the page keeps checking for the webhook's grant after a payment (2 s apart). */
const THANKS_POLL_MS = 90_000;

/** A coffee cup with a small heart over it: the footer button's mark (ours, inline). */
export const SUPPORT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" width="1.1em" height="1.1em"><path d="M4.5 10.5h11v4.2a4.8 4.8 0 0 1-4.8 4.8H9.3a4.8 4.8 0 0 1-4.8-4.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15.5 11.8h1.3a2.3 2.3 0 0 1 0 4.6h-1.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10 8.6c-1.7-1.1-2.8-2-2.8-3.2a1.5 1.5 0 0 1 2.8-.7 1.5 1.5 0 0 1 2.8.7c0 1.2-1.1 2.1-2.8 3.2z" fill="currentColor"/></svg>`;

/** A set's look on the preview (your own knife, so the finish shows on it). */
function setLook(id: SupporterSetId): LoadoutChoice {
  const st = SUPPORTER_SETS.find((x) => x.id === id) ?? SUPPORTER_SETS[0];
  // The set's gun camo (progression.ts: every Supporter set has one).
  const camo = COSMETICS.find((c) => c.slot === "camo" && c.set === st.id)?.id ?? null;
  return { body: getLoadout().body ?? "body-a", knife: getLoadout().knife ?? DEFAULT_COSMETICS.knife, camo, shape: DEFAULT_COSMETICS.shape, ...st.look };
}

/** The Loadout's model for trying the set on: every supporter item shown and clickable, nothing saved. */
export function previewModel(mine: () => boolean): LoadoutModel & { changed(): void; onEquip(fn: (id: string | null) => void): void; dress(look: Partial<LoadoutChoice>): void } {
  const choice = setLook(SUPPORTER_SETS[0].id);
  const fns = new Set<() => void>();
  const equipped = new Set<(id: string | null) => void>();
  return {
    userId: null,
    choice: () => ({ ...choice }),
    crown: () => null,
    owns: (c) => supporterItem(c),
    lock: () => ({ hint: "Supporter item", goal: "Supporter item", fraction: null }),
    earned: () => (mine() ? "Yours" : ""),
    setHairColor: (hex) => {
      choice.hairColor = hex;
      fns.forEach((f) => f());
    },
    setHairLength: (n) => {
      choice.hairLength = n;
      fns.forEach((f) => f());
    },
    // Support previews items only (the pool row is hidden: previewOnly).
    knifePool: () => null,
    setKnifePool: () => {},
    equip: (slot, id) => {
      choice[slot] = id;
      equipped.forEach((f) => f(id));
      fns.forEach((f) => f());
    },
    status: () => ({ kind: "idle", text: "" }),
    isNew: () => false,
    see: () => {},
    clearIndicators: () => {},
    on: (fn) => (fns.add(fn), () => fns.delete(fn)),
    /** Something the captions read changed (we learned the player is a supporter). */
    changed: () => fns.forEach((f) => f()),
    /** An item was tried on (the page follows its set). */
    onEquip: (fn) => void equipped.add(fn),
    /** Puts a set's look on (the card deck's pick): every slot at once, one redraw. */
    dress: (look) => {
      Object.assign(choice, look);
      fns.forEach((f) => f());
    },
  };
}

export interface SupportScreenOpts {
  /** The Loadout / Edit card (menu.ts): for supporters, instead of the ask. */
  loadout: () => void;
  editCard: () => void;
  /** Where the tabs go (the screen header). */
  tabsHost: HTMLElement;
}

type SupportTab = "page" | "gifting" | "top";
/** Back from a profile opened from Top supporters: open on that tab again. */
let reopenTop = false;

export function supportScreen(o: SupportScreenOpts): HTMLElement {
  const ask = h("div.sp-ask");
  let supporter = false;
  let disposed = false;
  let pendingTimer = 0;
  let mySupport: MySupport | null = null;
  const model = previewModel(() => supporter);
  const look = lookState();

  // --- every supporter item, grouped by set (loadout-view.ts), on the Loadout's own stage. The set picked in the card
  // deck dresses the stage in its look and lights it; trying an item on picks its set (the stage keeps what you tried).
  let set: SupporterSetId = SUPPORTER_SETS[0].id;
  let signedInAs: { provider: string } | null = null;
  const setHost = h("div.sp-set", { "data-set": set });
  const pickSet = (next: SupporterSetId, dress: boolean) => {
    if (next === set) return;
    set = setHost.dataset.set = next;
    deck.show(next);
    if (dress) model.dress(SUPPORTER_SETS.find((x) => x.id === next)?.look ?? {});
  };
  const deck = cardDeck(look, () => signedInAs, (id) => pickSet(id, true));
  model.onEquip((id) => {
    const next = cosmetic(id)?.set;
    if (next) pickSet(next, false);
  });
  let loadout: HTMLElement;
  const glowEditor = playerGlowControls({ root: () => root, preview: () => {
    model.changed(); loadout?.dispatchEvent(new Event("playerglowpreview"));
  } });
  loadout = loadoutView(model, { only: supporterItem, previewOnly: true, slot: "outfit", playerGlow: () => glowEditor.get() });
  setHost.append(loadout);
  // Your name's look and the glow controls sit under the items, beside the stage.
  const side = h("div.sp-side");
  const grid = loadout.querySelector<HTMLElement>(".lo-grid");
  const gridWatch: { disconnect(): void }[] = [];
  if (grid) {
    grid.replaceWith(side);
    side.append(grid);
    // Slots with more items than fit (Hat, Finish) scroll; a soft edge says there's more until the end is reached.
    const more = () => grid.classList.toggle("sp-more", grid.scrollTop + grid.clientHeight < grid.scrollHeight - 4);
    grid.addEventListener("scroll", more, { passive: true });
    const items = new MutationObserver(() => requestAnimationFrame(more));
    const size = new ResizeObserver(more);
    items.observe(grid, { childList: true });
    size.observe(grid);
    gridWatch.push(items, size);
  }

  // --- a supporter's pickers are their real look: seeded from the saved one (drawAsk) and saved a moment after the
  // last pick (POST /me/supporter, as Edit card does), one request at a time, each against the server's last answer
  // (support-look.ts lookSaver). A failed save puts the saved look back. Everyone else's picks only dress the cards.
  const nameStatus = h("span.pf-status");
  let fadeTimer = 0;
  const status = (text: string, kind = "") => {
    clearTimeout(fadeTimer);
    nameStatus.textContent = text;
    nameStatus.className = `pf-status ${kind}`;
  };
  const saver = lookSaver({
    save: (patch) => api.saveSupporter(patch, profileWriteGuard(lastKnownMe()?.id ?? "")),
    restore: (picks) => look.set(picks),
    status: (state) => {
      if (state === "idle") status("");
      else if (state === "saving") status("Saving…");
      else if (state === "error") status("Couldn't save", "error");
      else {
        status("Saved", "saved");
        fadeTimer = window.setTimeout(() => nameStatus.classList.add("fade"), 1500);
      }
    },
  });
  look.on(() => saver.edit(look));

  side.append(lookPickers(look, nameStatus, deck), glowEditor.panel);
  const perksLine = perks();
  const page = h("div.sp", { role: "tabpanel", "aria-labelledby": "sp-tab-page" }, h("div.sp-col", null, ask, deck.el, perksLine), setHost);
  // ← → flip the cards when nothing else is listening for them (focus on the page, not in a field or the item grid).
  const arrows = (e: KeyboardEvent) => {
    if (disposed) return removeEventListener("keydown", arrows);
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || page.hidden || !root.isConnected || root.closest("[inert]")) return;
    const t = document.activeElement;
    if (t && t !== document.body && !t.closest(".sp-col")) return;
    if (t instanceof HTMLInputElement || t?.closest(".sp-pick")) return;
    e.preventDefault();
    deck.step(e.key === "ArrowRight" ? 1 : -1);
  };
  addEventListener("keydown", arrows);
  // Supporting again lives on the Gifting tab: past the first $5, more support means more gift credits.
  const again = h("div.sp-again", { hidden: true });

  // --- the ask, or the thanks
  const readSupport = () => {
    const revision = playerGlowRevision();
    const editRevision = glowEditor.revision();
    return api.mySupport().then(s => ({ s, revision, editRevision }));
  };
  const drawAsk = (s: MySupport | null, revision = playerGlowRevision(), editRevision = glowEditor.revision()) => {
    if (disposed) return;
    clearTimeout(pendingTimer);
    // The first answer replaces the placeholder (drawPending): it fades in where the placeholder held its place.
    if (ask.classList.contains("pending")) ask.classList.replace("pending", "arrive");
    perksLine.style.visibility = "";
    mySupport = s;
    const glowCurrent = revision === playerGlowRevision();
    const preserveGlowEdits = editRevision !== glowEditor.revision();
    const nextGlow = glowCurrent ? s?.supporter?.playerGlow ?? null : getPlayerGlow();
    if (s && glowCurrent && !preserveGlowEdits) setPlayerGlow(nextGlow);
    const since = s?.supporter ? new Date(s.supporter.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
    if (supporter !== !!since) (supporter = !!since), model.changed();
    perksLine.hidden = !!since;
    glowEditor.seed(nextGlow, preserveGlowEdits);
    if (since && s?.supporter && !saver.seeded) {
      const own = s.supporter;
      look.own = { color2: own.nameColor2 };
      const picks = savedPicks(own);
      saver.seed(picks);
      look.set(picks);
    }
    again.hidden = !(since && s?.payments);
    if (since) {
      // Back from paying again: the payment adds to their total (the webhook credits it within seconds).
      const paidAgain = backFromCheckout;
      backFromCheckout = false;
      ask.replaceChildren(
        h("p.sp-lead", null, paidAgain ? "Thank you again!" : "Thanks for supporting bunnyhop.lol."),
        h("p", null, paidAgain ? "Your payment went through. Any new gift credits show up on Gifting." : `Supporter since ${since}.`),
        h(
          "div.sp-actions",
          null,
          h("button.btn.primary", { type: "button", onclick: o.loadout, "data-autofocus": "" }, "Open Loadout"),
          h("button.btn", { type: "button", onclick: o.editCard }, "Edit card"),
        ),
      );
      // Supporting again (any amount from the minimum): Stripe Checkout like the first time; it adds to their Top
      // supporters total and their gift credits (src/stripe.ts credits every payment).
      if (s?.payments) again.replaceChildren(h("h3.sp-h", null, "Support again"), h("p", null, "Any amount adds to your total, and every full $5 is another gift credit."), ...payForm(s.minUsd || SUPPORTER_MIN_USD, "Support", false));
      return;
    }
    if (s?.payments) return drawPay(s);
    // No answer (the status or the session couldn't be read): not a guess that payments are closed (support-ask.ts).
    if (api.available() && askOf(s) === "failed") return ask.replaceChildren(...failedAsk());
    // Payments aren't open (the API has no Stripe key): the plan in plain words, and a button that can't be pressed
    // where the real one goes.
    const discord = discordLink("sp-discord", "the Discord");
    const when = h("span.sp-when", { hidden: true }, "We'll announce it in ", discord, ".");
    new MutationObserver(() => (when.hidden = discord.hidden)).observe(discord, { attributes: true, attributeFilter: ["hidden"] });
    ask.replaceChildren(
      h("p.sp-lead", null, "Supporting opens soon."),
      h("p", null, `One payment of $${SUPPORTER_MIN_USD} or more, any amount you like. It covers the servers and the tools the game is made with. The game stays free, and nothing you can buy helps you play.`),
      h("div.sp-actions", null, h("button.btn.sp-soon", { type: "button", disabled: true, "aria-disabled": "true" }, "Coming soon"), when),
    );
  };
  // Payments open: an amount (whole dollars, the minimum by default) and a button to Stripe's page. Guests save their
  // account first: a guest lives in one browser, and the perks must stay with the player.
  const drawPay = (s: MySupport) => {
    if (backFromCheckout) return drawPaid();
    const min = s.minUsd || SUPPORTER_MIN_USD;
    const guest = signedInAs?.provider === "guest";
    ask.replaceChildren(
      h("p.sp-lead", null, "Support bunnyhop.lol"),
      h("p", null, `Pay once, $${min} or more. It covers the servers, and the game stays free: nothing you buy helps you play. Every $5 after the first is a gift for another player.`),
      ...(guest ? [h("div.sp-actions", null, h("button.btn.primary", { type: "button", onclick: () => openAccount("save") }, "Save your account to support"))] : payForm(min, "Support")),
    );
  };
  /** An amount (whole dollars, `min` by default) and a button to Stripe's page, plus the error line. */
  const payForm = (min: number, label: string, primary = true): HTMLElement[] => {
    // The Wavedash build doesn't take payments (they would leave Wavedash's frame and its store): support happens on the
    // site, on the same account (add email in Account to sign in there).
    if (WAVEDASH)
      return [
        h("p.dim", null, "Supporting happens on bunnyhop.lol, on this same account: add email or a password in Account if you haven't, then sign in with it there."),
        h("div.sp-actions", null, h(`button.btn${primary ? ".primary" : ""}`, { type: "button", onclick: () => void wavedashCopy("https://bunnyhop.lol/?support") }, "Copy the link")),
      ];
    const amount = h("input.es-input.sp-amount", { type: "number", min: String(min), max: "1000", step: "1", value: String(min), inputmode: "numeric", "aria-label": "Amount in US dollars" }) as HTMLInputElement;
    const err = h("p.sp-err", { role: "alert", hidden: true });
    const btn = h(`button.btn${primary ? ".primary" : ""}`, { type: "button" }, label) as HTMLButtonElement;
    const dollars = () => Number(amount.value);
    const valid = () => Number.isInteger(dollars()) && dollars() >= min && dollars() <= 1000;
    amount.addEventListener("input", () => {
      btn.disabled = !valid();
      err.hidden = true;
    });
    const pay = async () => {
      if (!valid()) return;
      btn.disabled = amount.disabled = true;
      btn.textContent = "Opening…";
      try {
        location.href = (await api.supportCheckout(dollars() * 100)).url;
      } catch (e) {
        err.textContent = e instanceof Error && e.message ? e.message : "Couldn't open the payment page. Try again.";
        err.hidden = false;
        btn.disabled = amount.disabled = false;
        btn.textContent = label;
      }
    };
    btn.addEventListener("click", () => void pay());
    amount.addEventListener("keydown", (e) => e.key === "Enter" && void pay());
    return [h("div.sp-actions", null, h("label.sp-dollars", null, h("span", { "aria-hidden": "true" }, "$"), amount), btn), err];
  };

  // Back from a payment: thanks at once, and the supporter view as soon as the webhook has made it so.
  const drawPaid = () => {
    ask.replaceChildren(h("p.sp-lead", null, "Thank you!"), h("p", null, "Your payment went through. Your supporter perks show up here in a few seconds."));
    const until = Date.now() + THANKS_POLL_MS;
    const generation = accountGeneration();
    const check = () =>
      void readSupport().then(
        ({ s, revision, editRevision }) => generation === accountGeneration() && !disposed && (s.supporter ? ((backFromCheckout = false), drawAsk(s, revision, editRevision)) : Date.now() < until && setTimeout(check, 2000)),
        () => generation === accountGeneration() && !disposed && Date.now() < until && setTimeout(check, 2000),
      );
    check();
  };
  // Until GET /me/support answers, the ask's place is held (the payments-open copy, unseen) rather than drawn as
  // "Supporting opens soon" and then swapped for the real state a moment later: payments are open on the live site,
  // and a supporter gets a thank-you there instead, so that first frame was wrong for everyone.
  const drawPending = () => {
    clearTimeout(pendingTimer);
    ask.classList.add("pending");
    ask.classList.remove("arrive");
    perksLine.style.visibility = "hidden";
    ask.replaceChildren(
      h("p.sp-lead", null, "Support bunnyhop.lol"),
      h("p", null, `Pay once, $${SUPPORTER_MIN_USD} or more. It covers the servers, and the game stays free: nothing you buy helps you play. Every $5 after the first is a gift for another player.`),
      h("div.sp-actions", null, h("button.btn.primary", { type: "button", tabindex: "-1" }, "Support")),
    );
    // Fetch has no deadline: a stalled /me or /me/supporter must not leave this blank forever.
    // Keep waiting for the real answer, without guessing whether payments are open or this player supports us.
    pendingTimer = window.setTimeout(() => {
      if (disposed) return;
      ask.classList.replace("pending", "arrive");
      perksLine.style.visibility = "";
      ask.replaceChildren(...failedAsk());
    }, 8000);
  };
  // The status couldn't be read (or is taking too long): say so, and offer the read again.
  let retry = () => {};
  const failedAsk = () => [
    h("p.sp-lead", null, "Support bunnyhop.lol"),
    h("p", { role: "status" }, "Couldn't load your support status."),
    h("div.sp-actions", null, h("button.btn", { type: "button", onclick: () => retry() }, "Try again")),
  ];
  // Who is playing, then their status, then the ask. `named` gets the player as soon as they're known.
  const loadAsk = (named: (u: User | null) => void) => {
    const generation = accountGeneration();
    const live = () => generation === accountGeneration() && !disposed;
    const known = (u: User | null) => {
      if (!live()) return;
      signedInAs = u;
      named(u);
    };
    retry = () => {
      drawPending();
      loadAsk(named);
    };
    void supportStatus(me, (u) => (known(u), readSupport())).then(({ user, status }) => {
      if (!live()) return;
      if (!user) known(null);
      drawAsk(status?.s ?? null, status?.revision, status?.editRevision);
      if (tab === "top") drawTopPage();
    });
  };
  if (api.available()) drawPending();
  else drawAsk(null); // a build without a server

  // --- Top supporters, a tab of its own (with the API only)
  const topPage = h("div.sp-top-page", { role: "tabpanel", "aria-labelledby": "sp-tab-top" });
  let top: TopSupporter[] | "failed" | null = null;
  const drawTopPage = () => topPage.replaceChildren(...(mySupport?.supporter ? [boardSwitch(mySupport)] : []), topList(top));

  const giftingPage = supportGifting({ name: () => look.name, again });
  look.on(() => giftingPage.dispatchEvent(new Event("support-preview-refresh")));
  const root = h("div.sp-screen", null, page);
  let mounted = false;
  const cleanup = new MutationObserver(() => {
    mounted ||= root.isConnected;
    if (!mounted || root.isConnected) return;
    disposed = true;
    clearTimeout(pendingTimer);
    glowEditor.dispose();
    saver.reset();
    clearTimeout(fadeTimer);
    gridWatch.forEach((w) => w.disconnect());
    cleanup.disconnect();
  });
  cleanup.observe(document.body, { childList: true, subtree: true });
  let tab: SupportTab = "page";
  const tabs: [SupportTab, string][] = [
    ["page", "What you get"],
    ["gifting", "Gifting"],
    ...(api.available() ? [["top", "Top supporters"] as [SupportTab, string]] : []),
  ];
  const tabBar = h("div.pf-tabs", { role: "tablist", "aria-label": "Support" });
  scrollCue(tabBar, "x");
  const drawTabs = () =>
    tabBar.replaceChildren(
      ...tabs.map(([t, label]) =>
        h(
          `button.pf-tab${t === tab ? ".on" : ""}`,
          { type: "button", role: "tab", id: `sp-tab-${t}`, "aria-selected": String(t === tab), tabindex: t === tab ? "0" : "-1", onclick: () => select(t) },
          label,
        ),
      ),
    );
  const select = (t: SupportTab) => {
    if (t === tab) return;
    tab = t;
    drawTabs();
    if (t === "top") drawTopPage();
    // The page stays built (the stage keeps its WebGL context): only hidden while the list shows.
    page.hidden = t !== "page";
    if (t === "top") root.append(topPage);
    else topPage.remove();
    if (t === "gifting") {
      root.append(giftingPage);
      giftingPage.dispatchEvent(new Event("support-preview-refresh"));
    } else giftingPage.remove();
  };
  tabBar.addEventListener("keydown", (e) => {
    const i = tabs.findIndex(([t]) => t === tab);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (j === null) return;
    e.preventDefault();
    select(tabs[(j + tabs.length) % tabs.length][0]);
    tabBar.querySelector<HTMLElement>(".pf-tab.on")?.focus();
  });
  drawTabs();
  o.tabsHost.append(tabBar);
  if (api.available()) {
    void api.supporters().then(
      (r) => ((top = r.top), tab === "top" && drawTopPage()),
      () => ((top = "failed"), tab === "top" && drawTopPage()),
    );
    loadAsk((u) => u && look.name === "Your name" && look.set({ name: u.name }));
    if (reopenTop) select("top");
  }
  onAccountChange(root, () => {
    glowEditor.reset();
    saver.reset();
    status("");
    signedInAs = null;
    supporter = false; drawPending();
    deck.reload();
    loadAsk((u) => look.set({ name: u?.name ?? "Your name" }));
  });
  reopenTop = false;
  return root;
}

/** A supporter's "Show me in Top supporters" switch (also the About page's thank-you list). */
function boardSwitch(s: MySupport): HTMLElement {
  const box = h("input.switch", { type: "checkbox", checked: !!s.supporter?.showOnBoard }) as HTMLInputElement;
  const status = h("span.pf-status", { role: "status", "aria-live": "polite" });
  box.onchange = async () => {
    box.disabled = true;
    status.textContent = "Saving…";
    try {
      const next = await api.saveSupporter({ showOnBoard: box.checked });
      box.checked = next.showOnBoard;
      status.textContent = "Saved";
    } catch {
      box.checked = !box.checked;
      status.textContent = "Not saved";
    }
    box.disabled = false;
  };
  return h("div.ce-booster", null, h("label.acct-toggle", null, box, h("span", null, "Show me in Top supporters")), status);
}

/** Top supporters: rank, name (in their look, with the badge), total, since. null: still loading. */
function topList(top: TopSupporter[] | "failed" | null): HTMLElement {
  if (!top) return h("p.sp-top-empty", null, "Loading…");
  if (top === "failed") return h("p.sp-top-empty", null, "Couldn't load the list. Try again in a bit.");
  if (!top.length) return h("p.sp-top-empty", null, "Nobody is on the list yet.");
  const fmtSince = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return h(
    "ol.sp-top",
    null,
    ...top.map((t, i) => {
      const a = nameAttrs({ nameColor: t.nameColor, nameEffect: t.nameEffect, nameColor2: t.nameColor2, nameFont: t.nameFont, nameStyle: t.nameStyle }, undefined, t.name);
      return h(
        "li.sp-top-row",
        null,
        h("span.sp-top-n", null, String(i + 1)),
        h("button.sp-top-name", { type: "button", title: `${t.name}'s profile`, onclick: () => ((reopenTop = true), navigate({ screen: "profile", id: t.id })) }, h("span", a, t.name), t.badge ? supporterMark() : null),
        h("span.sp-top-amt", null, `$${t.dollars.toLocaleString("en-US")}`),
        h("span.sp-top-since", null, `since ${fmtSince(t.since)}`),
      );
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The look the cards and the pickers share: the name's colour, effect and font, the avatar decoration and the card's
// border and effect (support-look.ts). For everyone else a preview; for a supporter their real look, saved on every
// pick (supportScreen, like Edit card).

interface Look extends LookPicks {
  /** A supporter's own look: the saved gradient colour (null = the automatic paler shade), not the preview's pick. */
  own: { color2: NameColorId | null } | null;
  /** The player's own name ("Your name" until we know it). */
  name: string;
  on(fn: () => void): void;
  set(p: Partial<LookPicks & Pick<Look, "name">>): void;
}

function lookState(): Look {
  const fns: (() => void)[] = [];
  const l: Look = {
    ...PREVIEW_LOOK,
    own: null,
    name: "Your name",
    on: (fn) => void fns.push(fn),
    set: (p) => (Object.assign(l, p), fns.forEach((f) => f())),
  };
  return l;
}

/** The look as the card reads it: a gradient's second colour is the next colour along (never the same one). */
function lookAttrs(l: LookPicks & Partial<Pick<Look, "own">>): SupporterLook {
  const more = { nameFont: l.font, nameStyle: l.style, avatarDeco: l.deco, cardBorder: l.border, cardEffect: l.cardEffect, hoverFx: l.hoverFx };
  if (l.own) return { nameColor: l.color, nameEffect: l.effect, nameColor2: l.own.color2, ...more };
  const i = NAME_COLORS.findIndex((c) => c.id === l.color);
  const color2 = NAME_COLORS[(i + 2) % NAME_COLORS.length].id;
  return { nameColor: l.color, nameEffect: l.effect, nameColor2: color2, ...more };
}

// ---------------------------------------------------------------------------------------------
// Your card, three times: the real player card (yours when signed in; without a profile, a fresh card under your name)
// in each set's frame, background, title and hat, with your name in the picked look. Held like a hand of cards: the
// picked set's card in front, the others fanned behind it in set order, and the sets' names under them (click a name or
// a card, or ← →; the landing dot marks the pick). A swap slides the fan and hops the new card to the front (transforms
// and opacity only; instant under Potato and reduced motion).

interface Deck {
  el: HTMLElement;
  /** Shows a set's card in front (no-op when it already is). */
  show(id: SupporterSetId): void;
  /** One step left or right (arrow keys), wrapping round. */
  step(by: -1 | 1): void;
  /** The account changed: read the profile again. */
  reload(): void;
  /** Whose card it is: the avatar the decoration pickers wear, and the peak (T7+) whose layers "None" keeps. */
  player(): Profile["player"];
}

const quietMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");

/** A card for someone with no profile to show (a guest the API doesn't know, offline): their name, a fresh start. */
function freshProfile(name: string, provider: string | null): Profile {
  const zeros = [0, 0, 0, 0, 0, 0];
  return {
    player: { id: "", name, avatarUrl: null, provider: provider ?? "", since: new Date().toISOString(), supporter: true },
    mine: true,
    level: { level: 1, xp: 0, into: 0, need: 100, fraction: 0 },
    rank: { scope: "all", points: 0, rank: null, ranked: 0, records: 0, wrs: 0, top10s: 0, group: { id: UNRANKED.id, name: UNRANKED.name, color: UNRANKED.color } },
    styles: [],
    stats: { clearsByTier: zeros, rankedByTier: zeros, maps: 0, pbs: 0, wrs: 0, top10s: 0, bonuses: 0, runs: 0, jumps: 0, seconds: 0, playtime: 0, replayViews: 0, styleMaps: {}, clearedMaps: [] },
    cosmetics: { ...DEFAULT_COSMETICS } as Profile["cosmetics"],
    badges: [],
    achievements: [],
    progress: null,
    featured: [],
  } as unknown as Profile;
}

function cardDeck(l: Look, who: () => { provider: string } | null, pick: (id: SupporterSetId) => void): Deck {
  let profile: Profile | null = null;
  let sel = 0;
  const fan = h("div.sp-deck", { "data-sel": "0" });
  const cards = SUPPORTER_SETS.map((st, i) => {
    const hop = h("div.sp-deck-hop");
    const card = h("div.sp-deck-card", { "data-set": st.id, "data-d": String(i) }, hop);
    // A card behind the front one: hover lifts it a little, a click brings it forward.
    card.addEventListener("pointerenter", (e) => e.pointerType !== "touch" && i !== sel && uiSound("ui_hover"));
    card.addEventListener("pointerdown", (e) => e.button === 0 && i !== sel && uiSound("ui_press"));
    card.addEventListener("click", () => i !== sel && pick(st.id));
    fan.append(card);
    return { st, card, hop };
  });
  const names = h("div.sp-pick.hop-host", { role: "tablist", "aria-label": "Supporter cards" });
  const tabs = SUPPORTER_SETS.map((st, i) =>
    h("button.sp-pick-name", { type: "button", role: "tab", "aria-selected": String(i === 0), tabindex: i === 0 ? "0" : "-1", onclick: () => pick(st.id) }, st.name),
  );
  names.append(...tabs);
  // The dot measures its row once it's on screen (the page is built before it's mounted).
  let tries = 0;
  const dot = () => (names.isConnected ? void hopIndicator(names, ".sp-pick-name", { axis: "x", selected: ".on", inset: 9 }) : ++tries < 120 && requestAnimationFrame(dot));
  requestAnimationFrame(dot);
  names.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    deck.step(e.key === "ArrowRight" ? 1 : -1);
    tabs[sel].focus();
  });

  const draw = () => {
    const p = profile ?? freshProfile(l.name, who()?.provider ?? null);
    const base: Profile = { ...p, player: { ...p.player, supporter: true } };
    for (const { st, hop } of cards) {
      const title = st.items.find((id) => id.startsWith("title-")) ?? "title-supporter";
      const c = { ...base.cosmetics, title, frame: `frame-${st.id}`, background: `bg-${st.id}`, hat: st.look.hat };
      hop.replaceChildren(playerCard(base, { cosmetics: c, nameLook: lookAttrs(l) }));
    }
  };
  const place = () => {
    fan.dataset.sel = String(sel);
    cards.forEach(({ card }, i) => {
      card.dataset.d = String(i - sel);
      card.setAttribute("aria-hidden", String(i !== sel));
    });
    tabs.forEach((t, i) => {
      t.classList.toggle("on", i === sel);
      t.setAttribute("aria-selected", String(i === sel));
      t.tabIndex = i === sel ? 0 : -1;
    });
  };
  const deck: Deck = {
    el: h("div.sp-cards", null, h("div.sp-deck-wrap", null, fan), names),
    show: (id) => {
      const i = SUPPORTER_SETS.findIndex((x) => x.id === id);
      if (i < 0 || i === sel) return;
      sel = i;
      place();
      // The new front card hops up out of the fan and lands.
      if (!quietMotion())
        cards[i].hop.animate(
          [
            { transform: "none", easing: "cubic-bezier(.33,1,.68,1)" },
            { transform: "translateY(-7%)", offset: 0.45, easing: "cubic-bezier(.32,0,.67,0)" },
            { transform: "none" },
          ],
          { duration: 260 },
        );
    },
    step: (by) => pick(SUPPORTER_SETS[(sel + by + SUPPORTER_SETS.length) % SUPPORTER_SETS.length].id),
    reload: () => {
      profile = null;
      draw();
      load();
    },
    player: () => (profile ?? freshProfile(l.name, who()?.provider ?? null)).player,
  };
  let loads = 0;
  const load = () => {
    const n = ++loads;
    if (api.available())
      void myProfile().then((p) => {
        if (!p || n !== loads) return;
        profile = p;
        l.set({ name: p.player.name });
      });
  };
  l.on(draw);
  draw();
  place();
  load();
  return deck;
}

// ---------------------------------------------------------------------------------------------
// Your look, beside the stage above the player glow: two views under one heading, so the column keeps its height.
//   Your name: colour, effect and font.   Your card: avatar decoration, card border, card effect and hover effect.
// The choices and swatches are Edit card's (ui/supporter-pickers.ts); every pick shows on the cards at once.

function lookPickers(l: Look, status: HTMLElement, deck: Pick<Deck, "player">): HTMLElement {
  let view: "name" | "card" = "name";
  const tabs = h("div.sp-look-tabs", { role: "tablist", "aria-label": "Your look" });
  const body = h("div.sp-look", { role: "tabpanel" });
  /** One row of choices: a radio group of swatch buttons, its label (Your card's rows) beside it. */
  const row = <T extends string | null>(label: string, shown: string | null, choices: { id: T; name: string }[], cur: T, look: (id: T) => HTMLElement, pick: (id: T) => void) =>
    h(
      "div.sp-look-row",
      null,
      shown ? h("span.sp-look-label", { "aria-hidden": "true" }, shown) : null,
      h(
        "div.sp-look-opts",
        { role: "radiogroup", "aria-label": label },
        ...choices.map((c) =>
          h(`button.sp-look-i${cur === c.id ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(cur === c.id), "aria-label": c.name, title: c.name, "data-id": c.id ?? "none", onclick: () => pick(c.id) }, look(c.id)),
        ),
      ),
    );
  const draw = () => {
    // A pick redraws the rows: keep focus on the same choice for keyboard players.
    const active = document.activeElement;
    const at = active && body.contains(active) ? [...body.querySelectorAll("button")].indexOf(active as HTMLButtonElement) : -1;
    // A tab switch (pointer or keys) redraws the tabs too: focus moves to the selected one (Sol R2).
    const onTab = !!active && tabs.contains(active);
    tabs.replaceChildren(
      ...(["name", "card"] as const).map((v) =>
        h(`button.sp-look-tab${v === view ? ".on" : ""}`, { type: "button", role: "tab", "aria-selected": String(v === view), tabindex: v === view ? "0" : "-1", "data-view": v, onclick: () => {
          if (v !== view) (view = v), draw();
          // Also where a click doesn't focus a button (Safari): keep focus on the tab, as the arrow keys do.
          tabs.querySelector<HTMLElement>(".sp-look-tab.on")?.focus({ preventScroll: true });
        } }, v === "name" ? "Your name" : "Your card"),
      ),
    );
    const attrs = lookAttrs(l);
    if (view === "name") {
      const colours = h("div.sp-colours", { role: "radiogroup", "aria-label": "Name colour" });
      colours.append(
        ...COLOUR_CHOICES.map((c) =>
          h(`button.sp-swatch${l.color === c.id ? ".on" : ""}`, { type: "button", role: "radio", "aria-checked": String(l.color === c.id), "aria-label": c.name, title: c.name, style: `--sw:${c.hex}`, onclick: () => l.set({ color: c.id }) }),
        ),
      );
      const effects = h(
        "div.sp-fx",
        { role: "radiogroup", "aria-label": "Name effect" },
        ...EFFECT_CHOICES.map((e) => {
          const a = nameAttrs({ ...attrs, nameEffect: e.id }, "#eef1f6");
          return h(
            `button.sp-fx-i${l.effect === e.id ? ".on" : ""}`,
            { type: "button", role: "radio", "aria-checked": String(l.effect === e.id), onclick: () => l.set({ effect: e.id }) },
            h("span.sp-fx-s", { "aria-hidden": "true", style: a.style, class: a.class }, "Aa"),
            e.name,
          );
        }),
      );
      // v0.0.40: bold / italic in the cuts the picked font has (none: no row); a pick the font lacks shows as Plain.
      const styles = styleChoices(l.font);
      const shown = nameStyleShown(l.font, l.style);
      body.replaceChildren(
        colours,
        effects,
        row("Name font", null, FONT_CHOICES, l.font, (id) => nameSample({ ...attrs, nameFont: id }), (id) => l.set({ font: id })),
        ...(styles.length ? [row("Bold and italic", null, styles, shown, (id) => nameSample({ ...attrs, nameStyle: id }), (id) => l.set({ style: id }))] : []),
      );
    } else {
      const player = deck.player();
      const peak = peakOf(player.special);
      body.replaceChildren(
        row("Avatar decoration", "Avatar", DECO_CHOICES, l.deco, (id) => decoSwatch(player, id, l.color), (id) => l.set({ deco: id })),
        row("Card border", "Border", borderChoices(peak), l.border, (id) => cardFxSwatch(peak, id, null, l.color), (id) => l.set({ border: id })),
        row("Card effect", "Effect", cardEffectChoices(peak), l.cardEffect, (id) => cardFxSwatch(peak, null, id, l.color), (id) => l.set({ cardEffect: id })),
        row("Hover effect", "Hover", HOVER_FX_CHOICES, l.hoverFx, (id) => hoverFxSwatch(id, l.color), (id) => l.set({ hoverFx: id })),
      );
    }
    if (at >= 0) body.querySelectorAll("button")[at]?.focus({ preventScroll: true });
    if (onTab) tabs.querySelector<HTMLElement>(".sp-look-tab.on")?.focus({ preventScroll: true });
  };
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    view = view === "name" ? "card" : "name";
    draw();
  });
  l.on(draw);
  draw();
  return h("div.sp-name", null, h("div.sp-look-head", null, tabs, status), body);
}

/** The rest, in a sentence. */
function perks(): HTMLElement {
  return h("p.sp-perks", null, "You also get name fonts, avatar decorations, card borders and effects, an effect on your mini profile, a heart by your name, a reserved spot on full servers and a place in Top supporters.");
}

export const openSupport = () => navigate({ screen: "support" });
