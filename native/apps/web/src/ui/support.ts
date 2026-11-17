import { appLocation } from "../platform/navigation";
import { playerGlowControls } from "./player-glow-controls";
// The Support page (menu screen "support"; ui/nav.ts { screen: "support" }, /?support): supporting bunnyhop.lol (one-time
// payments through Stripe Checkout, src/stripe.ts in the API; "Coming soon" while the API has no Stripe key) and
// everything supporters get, to look at and try on. Opened from the main menu's footer, the pause menu's support link,
// the About page and any locked supporter item's "Supporter item" (loadout-view.ts goalText).
//
// Five tabs in the screen header (menu.ts passes the slot, as for the profile), one section each:
//
//   What you get     the ask (or the thanks) and, under it, what a Supporter gets as five plain rows that open the
//                    section they are about; beside it your own card, fading through Supporter designs
//   Loadout          what you wear and use in the game, slot by slot, on the Loadout's own stage (support-loadout.ts)
//   Player card      your card, large, and a row of choices for each card and name look (support-card.ts)
//   Gifting          gift credits, Support again, the Gifter badge (support-gifting.ts)
//   Top supporters   the list, and a supporter's switch to be on it
//
// What goes in the Loadout and Player card sections is read from the catalogue (support-page.ts), and
// test/support-page.test.ts fails when a Supporter item or look has no place in them.
//
// Each section has its own room: a tab's panel fills the screen and, where its content can outgrow that, scrolls inside
// itself. Nothing is fitted into a fixed box next to something else that grows (how the v0.0.42 page lost its item
// grid). The Loadout and Player card sections are built the first time they are opened and then kept, hidden, so the
// stage keeps its WebGL context (the page's only one) and the picks stay.
//
// The ask stays at the top for everyone (owner, 2026-11-17). A supporter (GET /me/supporter: a payment, a gift or an
// admin's grant) is thanked there and offered the same form: giving again adds gift credits (the server's rule,
// src/gifting.ts giftCreditsEarned: the first $5 a player gives is their own Supporter, every full $5 after it is one
// credit), with the credits they hold and the way to Gifting under it. What an amount gives is worked out from the
// wallet the server reports (GET /me/gifts) and said under the amount before they pay. Their "Show me in Top
// supporters" switch is on that tab; Open Loadout and Edit card are in the sections. The previews follow the game's
// settings: Potato mode holds the animated ones still (viewmodel/finishes/shader.ts setCosmeticsStill), reduced motion
// stops the name effects (ui/marks.css), and both hold the decorations, borders and card effects still
// (avatar-deco.css, card-fx.css).

import { WAVEDASH } from "../platform/env";
import { wavedashCopy } from "../platform/wavedash";
import "./support.css";
import { api, lastKnownMe, type MySupport, type TopSupporter, type User } from "../api";
import { GIFT_CENTS, giftCreditsGained, type GiftWallet } from "../gifting";
import { askOf, supportStatus } from "../support-ask";
import { lookSaver, savedPicks } from "../support-look";
import { SUPPORT_EXTRAS, supportLoadoutCount } from "../support-page";
import { SUPPORTER_MIN_USD } from "../progression";
import { getPlayerGlow, playerGlowRevision, setPlayerGlow } from "../player/cosmetics";
import { discordLink } from "./community";
import { giftCreditCoin } from "./gifting";
import { me, openAccount, accountGeneration, onAccountChange } from "./account-state";
import { h } from "./dom";
import { icon } from "./icons";
import { nameAttrs, supporterMark } from "./marks";
import { navigate } from "./nav";
import { scrollCue } from "./scroll-cue";
import { cardOwner, cardSection, cardShowcase, lookState, type CardSection } from "./support-card";
import { profileWriteGuard } from "./profile-write";
import { supportGifting } from "./support-gifting";
import { loadoutSection, type LoadoutSection } from "./support-loadout";
// The look rows' choices and swatches are Edit card's, one implementation (ui/supporter-pickers.ts: FONT_CHOICES,
// DECO_CHOICES, borderChoices, cardEffectChoices, HOVER_FX_CHOICES and the rest), drawn by ui/support-card.ts.
export { previewModel } from "./support-loadout";

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

export interface SupportScreenOpts {
  /** The Loadout / Edit card (menu.ts): for supporters, instead of the ask. */
  loadout: () => void;
  editCard: () => void;
  /** Where the tabs go (the screen header). */
  tabsHost: HTMLElement;
}

type SupportTab = "page" | "loadout" | "card" | "gifting" | "top";
/** Back from a profile opened from Top supporters: open on that tab again. */
let reopenTop = false;

export function supportScreen(o: SupportScreenOpts): HTMLElement {
  const ask = h("div.sp-ask");
  let supporter = false;
  let disposed = false;
  let pendingTimer = 0;
  let mySupport: MySupport | null = null;
  let signedInAs: { provider: string } | null = null;
  // A supporter's gift wallet (GET /me/gifts): what they have given so far and the credits they hold. null until it
  // answers; the ask then says nothing it can't work out from it.
  let wallet: GiftWallet | null = null;
  /**
   * The lines that say what the typed amount gives, and the standing row: redrawn when the wallet answers. Each says
   * whether it is still on the page (one that isn't is dropped).
   */
  const walletDrawn = new Set<() => boolean>();
  // Everything the page listens for outside itself is let go the moment it closes.
  const closed = new AbortController();
  const look = lookState();
  const owner = cardOwner(look, () => signedInAs);

  let loadout: LoadoutSection | null = null;
  let card: CardSection | null = null;
  const glowEditor = playerGlowControls({ root: () => root, preview: () => loadout?.glowChanged() });
  const setSupporter = (yes: boolean) => {
    if (supporter === yes) return;
    supporter = yes;
    loadout?.supporter(yes);
    card?.supporter(yes);
  };

  // --- a supporter's look rows are their real look: seeded from the saved one (drawAsk) and saved a moment after the
  // last pick (POST /me/supporter, as Edit card does), one request at a time, each against the server's last answer
  // (support-look.ts lookSaver). A failed save puts the saved look back. Everyone else's picks only dress the cards.
  const nameStatus = h("span.pf-status", { role: "status", "aria-live": "polite" });
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

  // --- the first tab: the ask, what you get, and your card fading through designs
  const what = whatYouGet((t, part) => select(t, part));
  const col = h("div.sp-col", null, ask, what);
  const page = h("div.sp", { role: "tabpanel", "aria-labelledby": "sp-tab-page" }, col, cardShowcase(look, owner, closed.signal).el);
  // Supporting again lives on the Gifting tab: past the first $5, more support means more gift credits.
  const again = h("div.sp-again", { hidden: true });

  // --- the ask, or the thanks
  const readSupport = () => {
    const revision = playerGlowRevision();
    const editRevision = glowEditor.revision();
    const generation = accountGeneration();
    return api.mySupport().then(async (s) => {
      // A supporter's ask says what giving again gets them, which is worked out from their gift wallet: read with
      // the status, so the ask is drawn once, whole. A wallet that fails or is slow doesn't hold it back (the ask
      // then says the rule in general and fills in when the wallet answers: loadWallet).
      if (s.supporter) {
        const w = await Promise.race([api.giftWallet().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
        if (w && generation === accountGeneration()) wallet = w;
      }
      return { s, revision, editRevision };
    });
  };
  /** The answer takes the placeholder's place (drawPending): the ask and the rows under it come in together. */
  const arrive = () => {
    if (!ask.classList.contains("pending")) return;
    ask.classList.replace("pending", "arrive");
    col.classList.replace("pending", "arrive");
    ask.inert = false;
  };
  const drawAsk = (s: MySupport | null, revision = playerGlowRevision(), editRevision = glowEditor.revision()) => {
    if (disposed) return;
    clearTimeout(pendingTimer);
    arrive();
    mySupport = s;
    const glowCurrent = revision === playerGlowRevision();
    const preserveGlowEdits = editRevision !== glowEditor.revision();
    const nextGlow = glowCurrent ? s?.supporter?.playerGlow ?? null : getPlayerGlow();
    if (s && glowCurrent && !preserveGlowEdits) setPlayerGlow(nextGlow);
    const since = s?.supporter ? new Date(s.supporter.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
    setSupporter(!!since);
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
      const min = s?.minUsd || SUPPORTER_MIN_USD;
      ask.replaceChildren(...supporterAsk(since, paidAgain, !!s?.payments, min, standing()));
      // (Read with the status as a rule; here when that read was slow, and again after a payment as its credits land.)
      if (paidAgain) loadWallet([2000, 5000, 10000]);
      else if (!wallet) loadWallet();
      // The same form on the Gifting tab, beside the credits it adds to.
      if (s?.payments) again.replaceChildren(h("h3.sp-h", null, "Support again"), h("p", null, giveAgainRule()), ...payForm(min, "Support", false));
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
  const payAsk = (min: number, guest: boolean): HTMLElement[] => [
    h("p.sp-lead", null, "Support bunnyhop.lol"),
    h("p", null, `Pay once, $${min} or more. It covers the servers, and the game stays free: nothing you buy helps you play. Every $5 after the first is a gift for another player.`),
    ...(guest ? [h("div.sp-actions", null, h("button.btn.primary", { type: "button", onclick: () => openAccount("save") }, "Save your account to support"))] : payForm(min, "Support")),
  ];
  const drawPay = (s: MySupport) => {
    if (backFromCheckout) return drawPaid();
    ask.replaceChildren(...payAsk(s.minUsd || SUPPORTER_MIN_USD, signedInAs?.provider === "guest"));
  };
  // --- a supporter's ask: thanked, and offered the same form. What giving again gets is the server's rule, said from
  // the wallet it reports (never from a guess: without a wallet the sentence is the general one and the line under
  // the amount stays empty).
  const dollar = `$${GIFT_CENTS / 100}`;
  /** The rule in a sentence, as it applies to this player now. */
  const giveAgainRule = (): string =>
    wallet && wallet.donationCents < GIFT_CENTS
      ? `The first ${dollar} you give counts as your own. Every full ${dollar} after it is a gift credit, and each one makes another player a Supporter for good.`
      : `Every full ${dollar} is a gift credit, and each one makes another player a Supporter for good.`;
  const supporterAsk = (since: string, paidAgain: boolean, payments: boolean, min: number, standingRow: HTMLElement): HTMLElement[] => {
    const rule = h("p", null, paidAgain ? "Your payment went through. New gift credits show up here in a few seconds." : payments ? `Supporter since ${since}. You can give again whenever you like. ${giveAgainRule()}` : `Supporter since ${since}.`);
    if (!paidAgain && payments) walletDrawn.add(() => (rule.isConnected ? ((rule.textContent = `Supporter since ${since}. You can give again whenever you like. ${giveAgainRule()}`), true) : false));
    return [h("p.sp-lead", null, paidAgain ? "Thank you again!" : "Thanks for supporting bunnyhop.lol."), rule, ...(payments ? payForm(min, "Support") : []), standingRow];
  };
  /** Where they stand: the gift credits they hold, and the way to Gifting. */
  const standing = (): HTMLElement => {
    const credits = h("span.sp-standing-n");
    const draw = () => {
      const n = wallet?.credits;
      credits.replaceChildren(giftCreditCoin(), n === undefined ? "Gift credits" : `${n} gift credit${n === 1 ? "" : "s"}`);
      return credits.isConnected;
    };
    draw();
    walletDrawn.add(draw);
    return h("div.sp-standing", null, credits, h("button.link-btn", { type: "button", onclick: () => select("gifting") }, "Gifting", icon("chevronRight", { size: "0.9em" })));
  };
  /** Reads the wallet (again after each of `later` ms: a payment's credits land with the webhook) and redraws what shows it. */
  const loadWallet = (later: number[] = []) => {
    const generation = accountGeneration();
    const read = () =>
      void api.giftWallet().then(
        (w) => {
          if (disposed || generation !== accountGeneration()) return;
          wallet = w;
          for (const draw of [...walletDrawn]) if (!draw()) walletDrawn.delete(draw);
        },
        () => {},
      );
    read();
    for (const ms of later)
      setTimeout(() => {
        if (!disposed) read();
      }, ms);
  };
  addEventListener("bunnyhop:gifts-changed", () => supporter && loadWallet(), { signal: closed.signal });
  /**
   * What `dollars` gives, said under the amount before the player pays. A supporter's is worked out from their wallet
   * (empty until it has answered); a first payment starts from nothing given.
   */
  const gainOf = (dollars: number): string => {
    const credit = (n: number) => `${n} gift credit${n === 1 ? "" : "s"}`;
    if (!supporter) {
      const n = giftCreditsGained(0, dollars * 100);
      return n ? `$${dollars} makes you a Supporter and gives you ${credit(n)}.` : `$${dollars} makes you a Supporter.`;
    }
    if (!wallet) return "";
    const n = giftCreditsGained(wallet.donationCents, dollars * 100);
    return n ? `$${dollars} gives you ${credit(n)}.` : `$${dollars} counts as your own first ${dollar}: no gift credit yet.`;
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
    const gain = h("p.sp-gain", { "aria-live": "polite" });
    const btn = h(`button.btn${primary ? ".primary" : ""}`, { type: "button" }, label) as HTMLButtonElement;
    const dollars = () => Number(amount.value);
    const valid = () => Number.isInteger(dollars()) && dollars() >= min && dollars() <= 1000;
    const drawGain = () => ((gain.textContent = valid() ? gainOf(dollars()) : ""), gain.isConnected);
    drawGain();
    walletDrawn.add(drawGain);
    amount.addEventListener("input", () => {
      btn.disabled = !valid();
      err.hidden = true;
      drawGain();
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
    return [h("div.sp-actions", null, h("label.sp-dollars", null, h("span", { "aria-hidden": "true" }, "$"), amount), btn), gain, err];
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
  // Until GET /me/support answers, nothing of the ask is drawn as if it were known: not "Supporting opens soon"
  // (payments are open on the live site), not the form (a supporter gets another). The column waits unseen, the ask
  // and the rows under it, and comes in once, in its final place: nothing in it moves afterwards. The card beside it
  // doesn't wait for this.
  const drawPending = () => {
    clearTimeout(pendingTimer);
    ask.classList.add("pending");
    ask.classList.remove("arrive");
    col.classList.add("pending");
    col.classList.remove("arrive");
    ask.inert = true;
    ask.replaceChildren(...payAsk(SUPPORTER_MIN_USD, false));
    // Fetch has no deadline: a stalled /me or /me/supporter must not leave this blank forever.
    // Keep waiting for the real answer, without guessing whether payments are open or this player supports us.
    pendingTimer = window.setTimeout(() => {
      if (disposed) return;
      arrive();
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

  // --- the sections, made when first opened
  /** To the ask, from a section's button: the first tab, the amount (or whatever the ask offers) focused. */
  const toAsk = () => {
    select("page");
    ask.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
  };
  const askLabel = () => `Support from $${mySupport?.minUsd || SUPPORTER_MIN_USD}`;
  const build: Record<Exclude<SupportTab, "page">, (part?: string) => HTMLElement> = {
    loadout: (part) => {
      loadout = loadoutSection({
        isSupporter: () => supporter,
        glow: { panel: glowEditor.panel, get: () => glowEditor.get() },
        toAsk,
        askLabel,
        openLoadout: (slot) => (slot ? navigate({ screen: "loadout", slot }) : o.loadout()),
        slot: part,
      });
      return loadout.el;
    },
    card: () => {
      card = cardSection({ look, owner, status: nameStatus, toAsk, askLabel, editCard: o.editCard });
      card.supporter(supporter);
      return card.el;
    },
    gifting: () => {
      const el = supportGifting({ name: () => look.name, again, signal: closed.signal });
      look.on(() => !el.hidden && el.dispatchEvent(new Event("support-preview-refresh")));
      return el;
    },
    top: () => topPage,
  };
  const panels: Partial<Record<SupportTab, HTMLElement>> = { page };
  const root = h("div.sp-screen", null, page);
  let mounted = false;
  const cleanup = new MutationObserver(() => {
    mounted ||= root.isConnected;
    if (!mounted || root.isConnected) return;
    disposed = true;
    closed.abort();
    loadout?.closed();
    clearTimeout(pendingTimer);
    glowEditor.dispose();
    saver.reset();
    clearTimeout(fadeTimer);
    cleanup.disconnect();
  });
  cleanup.observe(document.body, { childList: true, subtree: true });

  let tab: SupportTab = "page";
  const tabs: [SupportTab, string][] = [
    ["page", "What you get"],
    ["loadout", "Loadout"],
    ["card", "Player card"],
    ["gifting", "Gifting"],
    ...(api.available() ? [["top", "Top supporters"] as [SupportTab, string]] : []),
  ];
  const tabBar = h("div.pf-tabs", { role: "tablist", "aria-label": "Support" });
  scrollCue(tabBar, "x");
  // The tabs are made once; a switch only moves the mark (and keeps the focus where it was).
  const tabButtons = tabs.map(([t, label]) => h("button.pf-tab", { type: "button", role: "tab", id: `sp-tab-${t}`, onclick: () => select(t) }, label));
  tabBar.append(...tabButtons);
  const drawTabs = () =>
    tabs.forEach(([t], i) => {
      tabButtons[i].classList.toggle("on", t === tab);
      tabButtons[i].setAttribute("aria-selected", String(t === tab));
      tabButtons[i].tabIndex = t === tab ? 0 : -1;
    });
  /** Opens a tab; `part`: where in it (the Player glow in the Loadout, the name rows on the Player card). */
  function select(t: SupportTab, part?: string): void {
    if (t !== tab) {
      tab = t;
      drawTabs();
      root.dataset.tab = t;
      let panel = panels[t];
      if (!panel) {
        // (A section made for a part of it opens there: the Loadout on its Player glow.)
        panel = panels[t] = build[t as Exclude<SupportTab, "page">](part);
        root.append(panel);
      }
      // Every panel that was made stays in the page (the Loadout's stage keeps its WebGL context, the picks stay):
      // only the one asked for shows.
      for (const [key, el] of Object.entries(panels)) el.hidden = key !== t;
      if (t === "top") drawTopPage();
      if (t === "card") card?.shown();
      if (t === "gifting") panel.dispatchEvent(new Event("support-preview-refresh"));
    }
    if (!part) return;
    if (t === "loadout") loadout?.show(part);
    if (t === "card") panels.card?.querySelector<HTMLElement>(`.sp-group[aria-label="${part}"]`)?.scrollIntoView({ block: "start" });
  }
  tabBar.addEventListener("keydown", (e) => {
    const i = tabs.findIndex(([t]) => t === tab);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (j === null) return;
    e.preventDefault();
    select(tabs[(j + tabs.length) % tabs.length][0]);
    tabBar.querySelector<HTMLElement>(".pf-tab.on")?.focus();
  });
  drawTabs();
  root.dataset.tab = tab;
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
    wallet = null;
    setSupporter(false);
    drawPending();
    owner.reload();
    loadAsk((u) => look.set({ name: u?.name ?? "Your name" }));
  }, closed.signal);
  reopenTop = false;
  return root;
}

/**
 * What a Supporter gets, under the ask: a row for each section of the page (the count is the catalogue's own), and the
 * things with nothing to show for them in a sentence (support-page.ts SUPPORT_EXTRAS).
 */
function whatYouGet(open: (tab: SupportTab, part?: string) => void): HTMLElement {
  const gift = `$${GIFT_CENTS / 100}`;
  const rows: [string, () => void][] = [
    [`${supportLoadoutCount()} items to wear and use in the game`, () => open("loadout")],
    ["Frames, borders and effects for your player card", () => open("card")],
    ["Colours, effects and fonts for your name", () => open("card", "Name")],
    ["A glow around your bunny", () => open("loadout", "glow")],
    [`A gift for another player with every ${gift} after your first`, () => open("gifting")],
  ];
  const extras = [...SUPPORT_EXTRAS];
  const last = extras.pop();
  return h(
    "div.sp-what",
    null,
    h("div.list-rows", null, ...rows.map(([text, go]) => h("button.list-row", { type: "button", onclick: go }, h("span.lr-text", null, text), icon("chevronRight", { size: "1rem" })))),
    h("p.sp-also", null, `Also ${extras.join(", ")} and ${last}.`),
  );
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

export const openSupport = () => navigate({ screen: "support" });
