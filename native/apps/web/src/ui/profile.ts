import {profileWriteGuard} from "./profile-write";
import { whisper } from "../notify";
import { playerGlowControls } from "./player-glow-controls";
import { DOTS } from "../social/dock";
import { withMenu, type MenuItem } from "../social/menu";
import { profileSocial } from "./profile-social";
import { openFeedback } from "../feedback/state";
import { profileGauntlets } from "./profile-gauntlets";
import { playerStatsSection, type PlayerStats } from "./stats-screen";
import { withReplayViews } from "./replay-views";
import { openGiftDialog } from "./gifting";
import { SIGN_IN_HELP } from "./account-copy";
// Profile screen (/?u=<id>, /u/<id>, any player name on a board, the account chip). One screen, no page scroll:
//   - tabs in the screen's header (menu.ts passes a slot for them), so they stay put whatever the tab shows.
//   - hero (left): the tilting player card (ui/card.ts) is the page: rank, level and records are on it, so no tiles
//     repeat them. Under it one row of actions (owner: Edit card; visitor: Race best run, Follow) + Share, and for
//     guests one "Sign in" link.
//     Edit card turns the hero into the card's editor (ui/card-editor.ts): the card stays, its parts (background,
//     frame, title, badges, links) are picked right under it, or by clicking them on the card. Esc / Done leaves.
//   - the tab (right), each one screen with internal scrolling only for long lists:
//       Overview    one flowing list: featured runs (Watch / Race / Pin on the hovered row), next-map suggestions,
//                   recent PBs, a line per style you're ranked in, then the activity numbers
//       Loadout     owner only, the whole width (no hero): every in-game look (ui/loadout-view.ts). The menus'
//                   Loadout shortcuts (pause menu, Settings → Viewmodel, unlock cards) open the profile here.
//       Runs        personal bests / every verified replay (virtualised, paged from the API)
// 0.0.13's Collection tab is gone: the Loadout has every in-game item (owned and locked, how each was earned), Edit card
// the card's items and every achievement (earned ones to pin, the rest with their goal and progress).
// v0.0.8's Customise tab is gone: a request for it (old links, unlock buttons) lands on the card editor or the Loadout
// (ui/cosmetic-slots.ts profileTarget). Offline (or no account yet) the screen is just the Loadout, kept on this device.
// The card itself carries clears by tier, WRs / top 10s / maps and runs / time / jumps, so the tabs don't repeat them.
// Layout borrowed from Aimperion's profile (hero card + side numbers) and hatchdle's nest (card + editor + badge sheet).
// Styles: ui/profile.css (.pf-*, .pc-* for the card).

import "./profile.css";
import { mouseFromPrefs } from "../mouse-settings";
import { prefs } from "./settings";
import { mouseProfileEditor, mouseProfileStats } from "./mouse-profile";
import { accountGeneration, profileFor, refreshMyProfile } from "./account-state";
import { countryPicker } from "./country-picker";
import { api, ApiError, ApiUnavailable, lastKnownMe, type PlayerGauntlets, type PointsRecord, type Profile, type RunCard } from "../api";
import { COSMETICS, supporterItem, type CosmeticChoice } from "../progression";
import { fmtPoints } from "../ranking";
import { styleLabel } from "../styles";
import { formatTime } from "../timer";
import { trackName } from "../zones";
import { focusEquipped, localModel, loadoutView, profileModel } from "./loadout-view";
import { cardEditor, Loadout, NewTracker, type CardEditor } from "./card-editor";
import { isCardPart, isLoadoutCategory, profileTarget, type CardPart, type ProfileTab } from "./cosmetic-slots";
import { communityConfig } from "./community";
import { playerCard, viewsLabel } from "./card";
import { topPoints } from "./profile-points";
import { h } from "./dom";
import { tierBadge } from "./maps";
import { navigate, profileUrl } from "./nav";
import { share } from "./share";
import { newDot } from "./unlocks";
import { linkChips } from "./marks";
import { linkList, type NameLook, type ProfileLinks } from "../creators";
import { landRows } from "./land";

const SHARE_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 12.5V2.5M6 6.5 10 2.5 14 6.5M4.5 10.5V17.5H15.5V10.5"/></svg>';

export type { ProfileTab };

export interface ProfileActions {
  play: (map: string, style?: string) => void;
  watch: (r: RunCard, player: string) => void;
  race: (r: RunCard, player: string) => void;
  ranks: (scope?: string) => void;
  toast: (msg: string) => void;
  /** Guests: the account flow's "save progress" entry point (owned by ui/account*.ts). */
  saveProgress?: (() => void) | null;
  /** The tab changed (the menu remembers it for Back / re-open). */
  onTab?: (tab: ProfileTab) => void;
}

export interface ProfileOpen {
  /** A tab, or "card" (the Overview with the card in edit mode); v0.0.8's "customise" still works. */
  tab?: ProfileTab | "card" | "customise" | null;
  /** Loadout: open on this category ("knife", "outfit", "trail", …); card: on this part ("frame", "badges", …). */
  slot?: string | null;
  /** Where the tab strip goes (the screen header); else above the layout. */
  tabsHost?: HTMLElement | null;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function placeLabel(r: { rank: number | null; players?: number | null }): HTMLElement {
  // A world record is told by the gold time itself (.pf-run.is-wr), not a chip.
  if (r.rank === 1) return h("span.place.wr-word", { title: "World record" });
  if (!r.rank) return h("span.place.dim", null, "—");
  return h(`span.place${r.rank <= 10 ? ".top10" : ""}`, null, `#${r.rank}`, r.players ? h("small.dim", null, `/${r.players}`) : null);
}

const TABS: [ProfileTab, string][] = [
  ["overview", "Overview"],
  ["loadout", "Loadout"],
  ["runs", "Runs"],
];

// ---------------------------------------------------------------------------------------------
// Skeleton: the same boxes as the loaded screen, so nothing moves when the data lands.

function skeleton(tabs: HTMLElement, tab: ProfileTab, mine: boolean): HTMLElement {
  const sk = (cls: string) => h(`div.sk.${cls}`);
  // The tabs the loaded screen will have (Loadout on your own profile only), so the row doesn't shift when it lands.
  const shown = TABS.filter(([t]) => t !== "loadout" || mine || tab === "loadout");
  tabs.replaceChildren(h("div.pf-tabs.is-loading", { "aria-hidden": "true" }, ...shown.map(([t, l]) => h(`span.pf-tab.sk-text${t === (tab ?? "overview") ? ".on" : ""}`, null, l))));
  // Opened on the Loadout: its own boxes (stage | grid), so the page doesn't jump from the card layout.
  if (tab === "loadout") return h("div.pf-layout.is-loading", { "aria-hidden": "true", "data-tab": "loadout" }, h("div.pf-main", null, h("div.pf-panel", null, h("div.lo-boot", null, h("div"), h("div")))));
  return h(
    "div.pf-layout.is-loading",
    { "aria-hidden": "true" },
    h("aside.pf-hero", null, h("div.pc-stage", null, sk("pf-sk-card")), h("div.pf-actions", null, sk("pf-sk-btn"), sk("pf-sk-btn.sm"))),
    h("div.pf-main", null, h("div.pf-panel", null, h("div.pf-sk-rows", null, ...Array.from({ length: 7 }, () => sk("pf-sk-row"))))),
  );
}

/** Offline, or no account yet: the Loadout alone, kept on this device. */
function offlineLoadout(root: HTMLElement, tabs: HTMLElement, open: ProfileOpen): void {
  tabs.replaceChildren(h("div.pf-tabs", { role: "tablist", "aria-label": "Profile sections" }, h("span.pf-tab.on", { role: "tab", "aria-selected": "true" }, "Loadout")));
  const view = loadoutView(localModel(), { slot: open.slot });
  root.replaceChildren(
    h(
      "div.pf-layout",
      { "data-tab": "loadout" },
      h("div.pf-main", null, h("div.pf-panel", { "data-tab": "loadout" }, view), h("p.pf-offline-note", null, "Profiles, ranks and achievements are offline. Your loadout is saved on this device.")),
    ),
  );
  requestAnimationFrame(() => focusEquipped(view));
}

/**
 * The reads the opening tab's sections make, which need only the id: they go out with the profile's own instead of
 * after it lands (each one a trip to the database). A section takes its read once; a profile that answers for another
 * id (a merged account) gets none and its sections read as before.
 */
interface EarlyReads {
  id: string;
  points?: Promise<{ scope: string; records: PointsRecord[] }>;
  gauntlets?: Promise<PlayerGauntlets>;
  stats?: Promise<PlayerStats>;
  runs?: Promise<{ total: number; runs: RunCard[] }>;
}
function earlyReads(id: string, tab: ProfileTab): EarlyReads {
  // (A fresh player's overview has none of these sections: nothing may be waiting on a failed read.)
  const quiet = <T>(p: Promise<T>) => (p.catch(() => {}), p);
  // Overview: Top points opens on Overall (topPoints; a player with only style points then reads their style's).
  if (tab === "overview") return { id, points: quiet(api.playerPoints(id, "all")), gauntlets: quiet(api.playerGauntlets(id)), stats: quiet(api.playerStats(id)) };
  // Runs: its first page, personal bests (runsTab).
  if (tab === "runs") return { id, runs: quiet(api.playerRuns(id, { offset: 0, limit: PAGE, pbOnly: true })) };
  return { id };
}

export function profileScreen(id: string, a: ProfileActions, open: ProfileOpen = {}): HTMLElement {
  const tabs = open.tabsHost ?? h("div.pf-tabs-host");
  const root = h("div.profile", { "aria-busy": "true" }, skeleton(tabs, profileTarget(open.tab, open.slot).tab, !!id && lastKnownMe()?.id === id));
  if (!open.tabsHost) root.prepend(tabs);
  const ownTabs = !open.tabsHost;
  if (!api.available() || !id) {
    offlineLoadout(root, tabs, open);
    if (ownTabs) root.prepend(tabs);
    root.removeAttribute("aria-busy");
    return root;
  }
  const accountEpoch = accountGeneration();
  const early = earlyReads(id, profileTarget(open.tab, open.slot).tab);
  // GET /config first (cached, one request per page): whether the Discord server rewards are listed (ui/community.ts).
  // Your own profile may come from the home screen's read (account-state.ts profileFor).
  Promise.all([profileFor(id), communityConfig()])
    .then(([p]) => {
      if (!root.isConnected) return;
      if (accountEpoch !== accountGeneration()) { tabs.replaceChildren(); root.replaceChildren(h("p.dim",null,"Account changed. Reopen this profile.")); return; }
      render(root, p, a, open, tabs, p.player.id === early.id ? early : { id: p.player.id });
      if (ownTabs) root.prepend(tabs);
    })
    .catch((e) => {
      // The server's unreachable: your own loadout still works, on this device.
      if (e instanceof ApiUnavailable && profileTarget(open.tab, open.slot).tab === "loadout") return offlineLoadout(root, tabs, open);
      const msg = e instanceof ApiUnavailable ? "Leaderboard server unreachable." : e instanceof ApiError && e.status === 404 ? "No player with that id." : String(e?.message ?? e);
      tabs.replaceChildren();
      root.replaceChildren(h("div.lb-state.error", null, h("strong", null, "Couldn't load profile"), h("span", null, msg)));
    })
    .finally(() => root.removeAttribute("aria-busy"));
  return root;
}

// ---------------------------------------------------------------------------------------------

function render(root: HTMLElement, p: Profile, a: ProfileActions, open: ProfileOpen, tabsHost: HTMLElement, early: EarlyReads): void {
  const writes=profileWriteGuard(p.player.id);
  const lo = new Loadout(p);
  const news = NewTracker.forProfile(p);
  let featuredIds = p.featuredAuto ? [] : p.featured.map((r) => r.runId);
  let featured = p.featured;
  const known = new Map<string, RunCard>([...p.featured, ...p.recentPBs].map((r) => [r.runId, r]));
  const target = profileTarget(open.tab, open.slot);

  // --- hero
  const cardSlot = h("div.pf-card");
  /** A hovered card item (card editor): shown on the card until the pointer leaves. */
  let cardPreview: Partial<CosmeticChoice> | null = null;
  /** A supporter's name look hovered in Edit card → Name, over what's saved (undefined: what's saved). */
  let namePreview: NameLook | undefined;
  let cardRaf = 0;
  let entered = false;
  const drawCard = () => {
    cardRaf = 0;
    cardSlot.replaceChildren(playerCard(p, { cosmetics: { ...lo.choice, ...cardPreview }, badges: lo.shownBadges(), featured, nameLook: namePreview, enter: !entered }));
    entered = true;
  };
  drawCard();
  lo.on(drawCard);

  const r = p.rank;
  // (Rank, points and level are on the card: no tiles repeating them. The card's level has its XP bar.)
  const copy = h(
    "button.btn.btn-ghost.pf-share.pf-icon",
    {
      type: "button",
      "data-act": "share",
      title: "Share this profile",
      "aria-label": "Share this profile",
      html: SHARE_ICON,
      onclick: async () => {
        const msg = await share({ url: profileUrl(p.player.id), title: `${p.player.name} · bunnyhop.lol`, text: `${p.player.name} on bunnyhop.lol` });
        if (msg === "Link copied") whisper("Copied", { at: copy });
        else if (msg) a.toast(msg);
      },
    },
  );
  const best = [...p.featured, ...p.recentPBs].filter((x) => x.pb).sort((x, y) => (y.points ?? 0) - (x.points ?? 0))[0] ?? p.featured[0] ?? null;
  const editBtn = p.mine ? h("button.btn.primary.pf-cta", { type: "button", "data-act": "edit", onclick: () => setEditing(true) }) : null;
  const social = profileSocial(p);
  const actions = h("div.pf-actions");
  // One row by relationship (ui/profile.css .pf-actions): one amber action that leans, the rest quiet, the extras in ⋯.
  //   yours:    Edit card · Loadout · Share · ⋯ (Profile flag, Mouse settings)
  //   theirs:   Follow / Follow back (the amber one) or Following ▾ / Friends ▾ (Message, Join, Invite, Unfollow) ·
  //             Race best run (amber once you follow) · Share · ⋯ (Gift Supporter, Block, Report)
  const drawActions = () => {
    const focused = actions.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.act : null;
    const more = (items: () => MenuItem[]) =>
      withMenu(h("button.btn.btn-ghost.pf-icon", { type: "button", "data-act": "more", title: "More", "aria-label": "More", html: DOTS }), items, { align: "right", label: "More" });
    if (p.mine) {
      actions.replaceChildren(
        editBtn!,
        h("button.btn.btn-ghost", { type: "button", "data-act": "loadout", onclick: () => select("loadout") }, "Loadout"),
        copy,
        more(() => [
          {
            label: "Profile flag",
            run: () =>
              countryPicker(p.player.country, () => {
                a.toast("Profile flag saved");
                navigate({ screen: "profile", id: p.player.id });
              }),
          },
          { label: "Mouse settings", run: () => mouseProfileEditor(() => (refreshMyProfile(), navigate({ screen: "profile", id: p.player.id }))) },
        ]),
      );
    } else {
      const rel = social.rel();
      const raceBtn = best
        ? h(
            `button.btn.pf-cta${rel ? ".primary" : ".pf-quiet"}`,
            { type: "button", "data-act": "race", onclick: () => a.race(best, p.player.name), title: `Race ${p.player.name}'s ghost on ${best.map}` },
            "Race best run",
            h("span.pf-cta-time", null, formatTime(best.time)),
          )
        : null;
      actions.replaceChildren(
        ...(api.available() ? [social.followControl()] : []),
        raceBtn ?? "",
        copy,
        more(() => [
          { label: "Gift Supporter", run: () => openGiftDialog({ recipientId: p.player.id, recipientName: p.player.name }) },
          api.available() && social.signedIn()
            ? social.blocked()
              ? { label: "Unblock", run: () => social.setBlocked(false) }
              : { label: "Block", tone: "bad", run: () => social.setBlocked(true) }
            : null,
          api.available() ? { label: "Report", run: () => openFeedback({ category: "report", report: { id: p.player.id, name: p.player.name } }) } : null,
        ]),
      );
    }
    if (focused) actions.querySelector<HTMLElement>(`[data-act="${focused}"]`)?.focus({ preventScroll: true });
  };
  drawActions();
  social.onChange(drawActions);
  // Nothing ranked yet: one quiet line under the card instead of zeros.
  const fresh = !r.points && !p.featured.length && !p.recentPBs.length;
  // A guest's own profile with something to keep: one text link (the account panel explains the rest).
  const nudge =
    p.mine && !fresh && p.player.provider === "guest" && a.saveProgress
      ? h("button.link-btn.pf-nudge", { type: "button", title: SIGN_IN_HELP, onclick: () => a.saveProgress!() }, "Sign in to keep your progress ›")
      : null;
  // Profile links (YouTube / Twitch / X / TikTok) the player chose to show; the owner's edits (Edit card → Links) redraw it.
  const linksSlot = h("div.pf-links");
  const drawLinks = () => linksSlot.replaceChildren(linkChips(p.links) ?? "");
  drawLinks();
  const onLinks = (links: ProfileLinks, show: boolean) => {
    p.links = show ? linkList(links) : [];
    p.linkSettings = { links, show };
    drawLinks();
  };
  const hero = h(
    "aside.pf-hero",
    null,
    cardSlot,
    social.counts,
    actions,
    nudge,
    fresh && p.mine ? h("p.pf-fresh", null, "Finish a map to get a rank.") : null,
    mouseProfileStats(p.mine ? mouseFromPrefs(prefs.get()) : p.player.mouse),
    linksSlot,
  );

  // --- the card editor (owner): the hero's numbers and actions make room for it; the card stays put
  const cardIds = COSMETICS.filter((c) => isCardPart(c.slot)).map((c) => c.id);
  let editor: CardEditor | null = null;
  function setEditing(on: boolean, part?: CardPart | null): void {
    if (!p.mine) return;
    if (on && editor) return void (part && editor.select(part));
    if (!on && !editor) return;
    cardPreview = null;
    namePreview = undefined;
    drawCard();
    if (on) {
      editor = cardEditor(p, lo, news, {
        part: part ?? null,
        onLinks,
        onBooster: (show) => {
          p.player.booster = show;
          drawCard();
        },
        onSupporter: (s) => {
          p.supporterSettings = s;
          p.player.supporter = s.showBadge;
          p.player.nameColor = s.nameColor;
          p.player.nameEffect = s.nameEffect;
          p.player.nameColor2 = s.nameColor2;
          namePreview = undefined;
          drawCard();
        },
        onNamePreview: (c) => {
          namePreview = c;
          if (!cardRaf) cardRaf = requestAnimationFrame(drawCard);
        },
        onPreview: (patch) => {
          cardPreview = patch;
          if (!cardRaf) cardRaf = requestAnimationFrame(drawCard);
        },
        done: () => setEditing(false),
      });
      hero.classList.add("editing");
      cardSlot.after(editor.el);
      requestAnimationFrame(() => editor?.el.querySelector<HTMLElement>(".ce-part.on")?.focus({ preventScroll: true }));
    } else {
      editor?.el.remove();
      editor = null;
      hero.classList.remove("editing");
      editBtn?.focus({ preventScroll: true });
    }
    drawEditBtn();
  }
  function drawEditBtn(): void {
    if (!editBtn) return;
    editBtn.replaceChildren("Edit card", news.pendingIn(cardIds) > 0 ? newDot("new card items") : "");
  }
  // In edit mode the card's parts are clickable: the title, the badges, the frame band, the rest is the background.
  cardSlot.addEventListener("click", (e) => {
    if (!editor) {
      // The card's featured tiles are the featured list's rows: a click takes you to the row.
      const id = (e.target as Element).closest<HTMLElement>(".pc-feat-tile[data-run]")?.dataset.run;
      if (!id) return;
      if (tab !== "overview") select("overview");
      const row = featBox.querySelector<HTMLElement>(`.pf-run[data-run="${CSS.escape(id)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      row.classList.remove("found");
      void row.offsetWidth;
      row.classList.add("found");
      row.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
      return;
    }
    const t = e.target as Element;
    const part = t.closest<HTMLElement>("[data-part]")?.dataset.part;
    if (isCardPart(part)) editor.select(part);
  });
  linksSlot.addEventListener("click", (e) => {
    if (editor && !(e.target as Element).closest("a")) editor.select("links");
  });
  // Esc leaves edit mode first (before the menu takes it as Back).
  const onEsc = (e: KeyboardEvent) => {
    if (!root.isConnected) return removeEventListener("keydown", onEsc, true);
    if (e.key !== "Escape" || !editor || e.defaultPrevented || e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    e.stopPropagation();
    setEditing(false);
  };
  addEventListener("keydown", onEsc, true);

  // --- tabs
  const tabs = TABS.filter(([t]) => t !== "loadout" || p.mine);
  let tab: ProfileTab = tabs.some(([t]) => t === target.tab) ? target.tab : "overview";
  const tabBar = h("div.pf-tabs", { role: "tablist", "aria-label": "Profile sections" });
  const panel = h("div.pf-panel", { role: "tabpanel", id: "pf-panel", tabindex: "-1" });
  // (Knives aren't unlocks: every knife is free, except the Supporter set's.)
  const loIds = COSMETICS.filter((c) => isLoadoutCategory(c.slot) && (c.slot !== "knife" || supporterItem(c))).map((c) => c.id);

  function drawTabs(): void {
    tabBar.replaceChildren(
      ...tabs.map(([t, label]) => {
        const extra = t === "runs" ? h("small", null, p.stats.runs.toLocaleString("en-US")) : null;
        const fresh = t !== tab && t === "loadout" && news.pendingIn(loIds) > 0;
        return h(
          `button.pf-tab${t === tab ? ".on" : ""}`,
          { type: "button", role: "tab", id: `pf-tab-${t}`, "aria-controls": "pf-panel", "aria-selected": String(t === tab), tabindex: t === tab ? "0" : "-1", onclick: () => select(t) },
          label,
          extra,
          fresh ? newDot("new unlocks") : null,
        );
      }),
    );
    drawEditBtn();
  }
  tabBar.addEventListener("keydown", (e) => {
    const i = tabs.findIndex(([t]) => t === tab);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    select(tabs[(j + tabs.length) % tabs.length][0]);
    tabBar.querySelector<HTMLElement>(".pf-tab.on")?.focus();
  });
  news.on(drawTabs);

  // --- run rows: tier as a coloured left edge, map, time (gold when it's the world record); Watch / Race show on the
  // hovered or focused row (always on touch).
  const runRow = (run: RunCard, o: { mini?: boolean } = {}) => {
    const pinned = featuredIds.includes(run.runId);
    const tags = [run.track ? trackName(run.track) : null, styleLabel(run.style), viewsLabel(run.views)].filter(Boolean).join(", ");
    const wr = run.pb && run.rank === 1;
    const t = run.tier ?? null;
    return h(
      `div.pf-run.${t ? `t${t}` : "tx"}${o.mini ? ".mini" : ""}${wr ? ".is-wr" : ""}`,
      { "data-run": run.runId, title: undefined },
      h(
        "span.pf-run-map",
        null,
        h("button.link-btn", { type: "button", onclick: () => a.play(run.map, run.style), title: `Play ${run.map} (tier ${t ?? "?"})` }, o.mini ? run.map.replace(/^bhop_/, "") : run.map),
        h("small", null, o.mini ? ago(run.date) : tags),
      ),
      h("span.pf-run-time", { title: wr ? "World record" : undefined }, formatTime(run.time)),
      h("span.pf-run-place", null, run.pb ? placeLabel(run) : h("span.dim", { title: "No longer the current PB on this board" }, "old")),
      o.mini ? null : h("span.pf-run-pts", null, run.points ? `${fmtPoints(run.points)}` : ""),
      o.mini ? null : h("span.pf-run-when", null, ago(run.date)),
      h(
        "span.pf-run-acts",
        null,
        withReplayViews(h("button.link-btn", { type: "button", onclick: () => a.watch(run, p.player.name), title: "Watch this replay" }, "Watch"), run.runId),
        o.mini ? null : h("button.link-btn", { type: "button", onclick: () => a.race(run, p.player.name), title: "Race this run as a ghost" }, "Race"),
        !o.mini && p.mine
          ? h(`button.link-btn.pf-pin${pinned ? ".on" : ""}`, { type: "button", "aria-pressed": String(pinned), onclick: () => void togglePin(run), title: pinned ? "Unpin from featured" : "Pin to featured (up to 5)" }, pinned ? "Pinned" : "Pin")
          : null,
      ),
    );
  };

  async function togglePin(run: RunCard): Promise<void> {
    known.set(run.runId, run);
    const next = featuredIds.includes(run.runId) ? featuredIds.filter((x) => x !== run.runId) : [...featuredIds, run.runId].slice(-5);
    try {
      featuredIds = await api.saveFeatured(next,writes);
      if(!writes.current())return;
      if (featuredIds.length) featured = featuredIds.map((x) => known.get(x)).filter((x): x is RunCard => !!x);
      else featured = (await api.profile(p.player.id)).featured;
      if(!writes.current())return;
      drawCard();
      drawFeatured();
      runs?.refresh();
      whisper(featuredIds.includes(run.runId) ? "Pinned" : "Unpinned");
    } catch (e) {
      a.toast(e instanceof ApiError ? e.message : "Couldn't save");
    }
  }

  // --- overview: one flowing list, headings and hairlines, no boxes. Rank overall is on the card; per style it's one
  // line each where there is one.
  const featBox = h("section.pf-sec.pf-feat");
  function drawFeatured(): void {
    featBox.replaceChildren(
      h("h3", null, "Featured runs", featuredIds.length ? h("small", null, `pinned by ${p.mine ? "you" : p.player.name}`) : null),
      featured.length
        ? h("div.pf-rows", null, ...landRows(featured.map((x) => runRow(x))))
        : h("p.pf-empty", null, p.mine ? "Pin runs from Runs to feature them here." : "No ranked runs yet."),
    );
  }
  drawFeatured();

  function overview(): HTMLElement {
    if (fresh) {
      return h(
        "div.pf-ov.is-fresh",
        null,
        p.mine ? null : h("p.pf-empty", null, `${p.player.name} hasn't finished a map yet.`),
      );
    }
    // Most points first: where the player is strongest leads (rank breaks a tie).
    const ranked = p.styles.filter((s) => s.rank).sort((x, y) => y.points - x.points || (x.rank ?? 0) - (y.rank ?? 0));
    const ranks = ranked.length
      ? h(
          "section.pf-sec.pf-ranks",
          null,
          h("h3", null, "Ranks", h("button.link-btn", { type: "button", onclick: () => a.ranks("all") }, "Rank board ›")),
          h(
            "div.pf-rank-rows",
            null,
            ...ranked.map((s) => h("button.pf-rank-row", { type: "button", onclick: () => a.ranks(s.scope), title: `${styleLabel(s.scope)} rank board` }, h("span", null, styleLabel(s.scope)), h("span.pf-rank-pts", null, `${fmtPoints(s.points)} pts`), h("b.pf-rank-pos", null, `#${s.rank}`))),
          ),
        )
      : null;
    const next =
      p.mine && p.suggestions.length
        ? h(
            "section.pf-sec.pf-next",
            null,
            h("h3", null, "Next up"),
            h(
              "div.pf-rows",
              null,
              ...p.suggestions.map((s) => h(`button.pf-next-row.t${s.tier ?? "x"}`, { type: "button", onclick: () => a.play(s.map), title: `Play ${s.map}` }, h("span.pf-run-map", null, h("b", null, s.map), h("small", null, s.reason)), h("span.pf-go", null, "Play ›"))),
            ),
          )
        : null;
    const recent = p.recentPBs.length
      ? h(
          "section.pf-sec.pf-recent",
          null,
          h("h3", null, "Recent personal bests", h("button.link-btn", { type: "button", onclick: () => select("runs") }, "All runs ›")),
          h("div.pf-rows", null, ...p.recentPBs.slice(0, 6).map((x) => runRow(x, { mini: true }))),
        )
      : null;
    const { points, gauntlets, stats } = early;
    Object.assign(early, { points: undefined, gauntlets: undefined, stats: undefined });
    return h("div.pf-ov", null, featBox, next, h("div.pf-ov-row", null, recent, ranks), topPoints(p, points), profileGauntlets(p.player.id, gauntlets), playerStatsSection(p.player.id, { compact: true, early: stats }));
  }

  // --- runs (virtualised)
  let runs: { el: HTMLElement; refresh: () => void } | null = null;
  let runsPbOnly = true;
  function runsTab(): HTMLElement {
    const seg = h("div.pf-seg", { role: "group", "aria-label": "Which runs" });
    const listHost = h("div.pf-runs-list");
    const drawSeg = () =>
      seg.replaceChildren(
        h(`button${runsPbOnly ? ".on" : ""}`, { type: "button", "aria-pressed": String(runsPbOnly), onclick: () => switchTo(true) }, "Personal bests", h("small", null, ` ${p.stats.pbs}`)),
        h(`button${!runsPbOnly ? ".on" : ""}`, { type: "button", "aria-pressed": String(!runsPbOnly), onclick: () => switchTo(false) }, "All replays", h("small", null, ` ${p.stats.runs}`)),
      );
    let list = virtualRuns(p.player.id, runsPbOnly, runRow, runsPbOnly ? early.runs : undefined);
    early.runs = undefined;
    const switchTo = (pb: boolean) => {
      if (pb === runsPbOnly) return;
      runsPbOnly = pb;
      list = virtualRuns(p.player.id, pb, runRow);
      listHost.replaceChildren(list.el);
      drawSeg();
      if (runs) runs.refresh = list.refresh;
    };
    drawSeg();
    listHost.append(list.el);
    const el = h(
      "section.pf-runs",
      null,
      h("div.pf-runs-bar", null, seg, h("span.pf-runs-note", null, p.mine ? "Pin up to 5 runs to feature them on your card." : `Race any run as a ghost.`)),
      listHost,
    );
    runs = { el, refresh: list.refresh };
    return el;
  }

  // --- tab switching (Overview / Runs are kept; the Loadout is rebuilt: its WebGL stage is parked when it leaves the
  // page and taken over by the next one, the thumbnails stay cached)
  const built = new Map<ProfileTab, HTMLElement>();
  let loSlot: string | null = target.slot;
  function content(t: ProfileTab): HTMLElement {
    if (t === "loadout") {
      let view: HTMLElement;
      const glow = playerGlowControls({ root: () => view, preview: () => view?.dispatchEvent(new Event("playerglowpreview")), support: true });
      view = loadoutView(profileModel(p, lo, news), { slot: loSlot, playerGlow: () => glow.get() });
      const glowSettings = h("details.lo-glow-settings", null,
        h("summary", null, "Player glow", h("small.dim", null, "Supporter")), glow.panel);
      glowSettings.addEventListener("toggle", () => {
        if (glowSettings.open) view.dispatchEvent(new Event("playerglowpreview"));
      });
      view.insertBefore(glowSettings, view.querySelector(".lo-body"));
      // Fetch after this tab is attached; saving is available only to an active supporter.
      glow.bind();
      loSlot = null;
      return view;
    }
    let el = built.get(t);
    if (!el) built.set(t, (el = t === "overview" ? overview() : runsTab()));
    return el;
  }
  function select(t: ProfileTab): void {
    if (t === tab && panel.childElementCount) return;
    tab = t;
    a.onTab?.(t);
    // The Loadout takes the whole width (no card): leave edit mode first.
    if (t === "loadout") setEditing(false);
    panel.setAttribute("aria-labelledby", `pf-tab-${t}`);
    panel.dataset.tab = t;
    layout.dataset.tab = t;
    panel.replaceChildren(content(t));
    drawTabs();
  }

  const layout = h("div.pf-layout", { "data-mine": p.mine ? "1" : "0" }, hero, h("div.pf-main", null, panel));
  tabsHost.replaceChildren(tabBar);
  root.replaceChildren(layout);
  const first = tab;
  tab = "overview";
  panel.replaceChildren();
  select(first);
  if (target.edit && first === "overview") setEditing(true, target.edit);

  // --- keyboard / controller (ui/gamepad.ts sends arrows, Enter, Esc, Q / E): Q / E switch tabs anywhere; arrows walk
  // the hero and the panel in reading order (grids and tab strips handle their own arrows first); ↓ from the tabs
  // enters the panel, ↑ from its top returns to the tabs, → from the hero's last control reaches the tabs.
  const focusTab = () => tabBar.querySelector<HTMLElement>(".pf-tab.on")?.focus({ preventScroll: true });
  const focusables = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select")].filter((x) => x.offsetParent !== null);
  const walk = (scope: HTMLElement, e: KeyboardEvent, onEdge: (dir: 1 | -1) => boolean) => {
    if (e.defaultPrevented || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const items = focusables(scope);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const j = i + dir;
    e.preventDefault();
    if (j < 0 || j >= items.length) {
      if (!onEdge(dir)) items[Math.max(0, Math.min(items.length - 1, j))].focus();
      return;
    }
    items[j].focus();
    items[j].scrollIntoView({ block: "nearest" });
  };
  hero.addEventListener("keydown", (e) => walk(hero, e, (dir) => (dir > 0 ? (focusTab(), true) : false)));
  panel.addEventListener("keydown", (e) => walk(panel, e, (dir) => (dir < 0 ? (focusTab(), true) : false)));
  tabBar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    focusables(panel)[0]?.focus();
  });
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return removeEventListener("keydown", onKey);
    const t = e.target as HTMLElement;
    // (Inside the Loadout, Q / E switch its category instead: it handles them first.)
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (k !== "q" && k !== "e") return;
    const i = tabs.findIndex(([x]) => x === tab);
    select(tabs[(i + (k === "e" ? 1 : -1) + tabs.length) % tabs.length][0]);
    focusTab();
  };
  addEventListener("keydown", onKey);
  // The menu focused Back while the profile loaded; a controller user starts on the tabs instead (in the Loadout, on
  // the item you hold).
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || active.matches(".screen-back")) {
    if (first === "loadout") requestAnimationFrame(() => focusEquipped(panel));
    else focusTab();
  }
}

// ---------------------------------------------------------------------------------------------
// Virtual run list: fixed-height rows, pages of 40 fetched as they scroll into view, skeleton rows meanwhile.

const PAGE = 40;

const runHead = () =>
  h("div.pf-run.pf-run-head", { "aria-hidden": "true" }, h("span", null, "Map"), h("span.pf-run-time", null, "Time"), h("span.pf-run-place", null, "Place"), h("span.pf-run-pts", null, "Points"), h("span.pf-run-when", null, "When"), h("span"));

/** `first`: page 0, already asked (earlyReads). */
function virtualRuns(id: string, pbOnly: boolean, row: (r: RunCard) => HTMLElement, first?: Promise<{ total: number; runs: RunCard[] }>): { el: HTMLElement; refresh: () => void } {
  const pages = new Map<number, RunCard[] | null>();
  const cache = new Map<number, HTMLElement>();
  let total = -1;
  let failed = false;
  const space = h("div.pf-vspace");
  // The column head sits inside the scroller (sticky) so its columns line up with the rows despite the scrollbar.
  const scroller = h("div.pf-vlist", { tabindex: "-1" }, runHead(), space);
  const rowH = () => parseFloat(getComputedStyle(scroller).getPropertyValue("--row-n")) * parseFloat(getComputedStyle(document.documentElement).fontSize) || 36;

  function load(pg: number): void {
    if (pages.has(pg)) return;
    pages.set(pg, null);
    const read = pg === 0 && first ? first : api.playerRuns(id, { offset: pg * PAGE, limit: PAGE, pbOnly });
    first = undefined;
    read.then(
      (res) => {
        pages.set(pg, res.runs);
        total = res.total;
        paint();
      },
      () => {
        pages.delete(pg);
        failed = true;
        paint();
      },
    );
  }

  let queued = false;
  function paint(): void {
    queued = false;
    if (total === 0 || (failed && total < 0)) {
      scroller.replaceChildren(h("p.pf-empty", null, failed ? "Couldn't load runs." : pbOnly ? "No personal bests yet." : "No verified runs yet."));
      return;
    }
    const H = rowH();
    const n = total < 0 ? 8 : total;
    space.style.height = `${n * H}px`;
    const top = scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / H) - 4);
    const last = Math.min(n, Math.ceil((top + (scroller.clientHeight || 400)) / H) + 4);
    if (total < 0) load(0);
    else for (let pg = Math.floor(first / PAGE); pg <= Math.floor((last - 1) / PAGE); pg++) load(pg);
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      let el = cache.get(i);
      if (!el) {
        const run = pages.get(Math.floor(i / PAGE))?.[i % PAGE];
        el = run ? row(run) : h("div.pf-run.pf-sk-run", { "aria-hidden": "true" }, h("span.sk"), h("span.sk"), h("span.sk"));
        if (run) cache.set(i, el);
      }
      el.style.top = `${i * H}px`;
      rows.push(el);
    }
    // Keep a focused row in the DOM even when it scrolls out of the window (keyboard users don't lose their place).
    const focused = document.activeElement?.closest(".pf-run") as HTMLElement | null;
    if (focused && space.contains(focused) && !rows.includes(focused)) rows.push(focused);
    space.replaceChildren(...rows);
  }
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };
  scroller.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(() => {
    cache.forEach((el, i) => (el.style.top = `${i * rowH()}px`));
    schedule();
  }).observe(scroller);
  paint();
  return {
    el: scroller,
    refresh: () => {
      cache.clear();
      paint();
    },
  };
}
