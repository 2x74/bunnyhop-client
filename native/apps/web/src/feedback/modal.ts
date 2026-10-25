import { appHref } from "../platform/navigation";
import { SIGN_IN_HELP } from "../ui/account-copy";
// The feedback form (opened from the pause menu, the home screen and the end-of-run hint through feedback/state.ts
// openFeedback). A modal dialog: while it's open no key reaches the game, the menus or the chat (ui/account-panel.ts
// modal() stops keydown at the dialog; the game itself only reads keys while pointer-locked) and Esc closes it.
//
// Sends POST /feedback (apps/api src/feedback.ts) with the category, the message, an optional contact and, when
// "Attach game info" is ticked, gameContext(): map + sha, style, track, timer, position / velocity, the run just
// submitted, client build, page, browser, screen, GPU, FPS, a few settings, the room and the last client errors.
// "Attach screenshot" grabs the game canvas right after the game rendered a frame (no preserveDrawingBuffer needed),
// downscaled to <= 1280 px wide and encoded as a JPEG of at most ~300 KB.
//
// "Moderator application" is a category with its own questions instead of the message box (Discord username, filled in
// from a linked Discord account; timezone and play hours; why; experience), each optional. It sends no game info or
// screenshot; the server writes the message from the answers, ties it to the account and takes one a week. Guests can
// apply, but are nudged to save their progress or link Discord first. The recruiting line (ui/community.ts) and
// /?apply=moderator open the form on it.

import { api, ApiError, ApiUnavailable, type FeedbackBody } from "../api";
import { modal } from "../ui/account-panel";
import { h } from "../ui/dom";
import { prefs } from "../ui/settings";
import { currentRoom } from "../net/presence";
import { gameInfo, lastSubmittedRun, recentErrors, type FeedbackCategory, type FeedbackOpen } from "./state";
import "./feedback.css";
import { backdropFrame } from "../ui/backdrop";
import { landIn, mascot } from "../notify";
import type { Mood } from "../notify/mascot";
import { getOutfit } from "../player/cosmetics";
import { me, openAccount } from "../ui/account-state";
import { discordLink } from "../ui/community";
import { gpuInfo } from "../gpu-info";
import { icon } from "../ui/icons";
import { mapArt } from "../ui/thumbs";
import { styleLabel } from "../styles";
import { tierLabel, tierName, TIERS } from "../tiers";
import { mapTier } from "../ui/maps";

const PLACEHOLDER: Record<FeedbackCategory, string> = {
  bug: "What happened, and what did you expect? Steps to make it happen again help a lot.",
  physics: "What felt off? e.g. lost speed landing on a ramp, a jump that works in CS:S but not here.",
  map: "Which part of the map? e.g. the end zone can't be reached, a missing texture, a stuck spot.",
  tier: "Why? Optional. e.g. one stage is much harder than the rest.",
  multiplayer: "What went wrong in the server? e.g. lag, chat, a player, map votes.",
  idea: "What would make bunnyhop.lol better for you?",
  other: "Tell us anything.",
  application: "",
};

/** The application's questions (apps/api src/feedback.ts APPLICATION_FIELDS: same keys and limits). */
const QUESTIONS: { key: "discord" | "hours" | "why" | "experience"; label: string; max: number; placeholder: string; long?: boolean }[] = [
  { key: "discord", label: "Discord username", max: 64, placeholder: "So we can talk to you there" },
  { key: "hours", label: "Timezone and usual play hours", max: 200, placeholder: "e.g. UTC+1, evenings and weekends" },
  { key: "why", label: "Why do you want to help?", max: 800, placeholder: "What you'd like to do as a moderator, and why", long: true },
  { key: "experience", label: "Any moderation experience?", max: 800, placeholder: "Other games, Discord servers, communities. None is fine too.", long: true },
];

const APPLY_LEAD = "Moderators keep the servers and chat friendly. Every question is optional. We reply in your Inbox.";

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 2000;
export const CONTACT_MAX = 120;
const SHOT_MAX_BYTES = 300 * 1024;
const SHOT_MAX_WIDTH = 1280;

let current: HTMLDialogElement | null = null;
/** What was typed when the form closed without sending: it comes back next time (a press outside closes it). */
let draft: { category: FeedbackCategory; text: string; contact: string } | null = null;
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------------------------
// Context

/** FPS from requestAnimationFrame while the form is open (the game keeps rendering behind it). */
function fpsSampler(): { read: () => number | null; stop: () => void } {
  const times: number[] = [];
  let raf = 0;
  let stopped = false;
  const tick = (t: number) => {
    times.push(t);
    if (times.length > 240) times.shift();
    if (!stopped) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    read: () => (times.length < 5 ? null : Math.round(((times.length - 1) * 1000) / (times[times.length - 1] - times[0]))),
    stop: () => ((stopped = true), cancelAnimationFrame(raf)),
  };
}

/** Page URL without sign-in tokens. */
function pageUrl(): string {
  const u = new URL(appHref());
  for (const k of ["signin", "token", "code", "login_error"]) u.searchParams.delete(k);
  return u.toString();
}

/** Everything "Attach game info" sends. Small on purpose (the API caps it at 16 KB anyway). */
export function gameContext(fps: number | null): Record<string, unknown> {
  const p = prefs.get();
  const runId = lastSubmittedRun();
  const room = currentRoom();
  // The hashed entry chunk of this deploy (/assets/index-<hash>.js); "dev" under Vite.
  const script = [...document.scripts].map((x) => x.getAttribute("src")).find((src) => !!src && src.includes("/assets/")) ?? (import.meta.env.DEV ? "dev" : null);
  const game = gameInfo();
  // The native client's menu (apps/native): its host reports the game and its own settings; this page's web build,
  // frame rate and web prefs say nothing about it.
  if (game?.client === "native") {
    const { nativeSettings, ...native } = game;
    return {
      ...native,
      ...(runId ? { runId } : {}),
      ...(room ? { room } : {}),
      screen: document.body.dataset.screen || null,
      ua: navigator.userAgent,
      lang: navigator.language,
      screenSize: `${screen.width}x${screen.height}`,
      viewport: `${innerWidth}x${innerHeight}`,
      dpr: Math.round(devicePixelRatio * 100) / 100,
      settings: nativeSettings ?? null,
      errors: recentErrors(),
    };
  }
  return {
    ...(game ?? { inGame: false }),
    ...(runId ? { runId } : {}),
    ...(room ? { room } : {}),
    screen: document.body.dataset.screen || null,
    page: pageUrl(),
    webBuild: script,
    ua: navigator.userAgent,
    lang: navigator.language,
    screenSize: `${screen.width}x${screen.height}`,
    viewport: `${innerWidth}x${innerHeight}`,
    dpr: Math.round(devicePixelRatio * 100) / 100,
    gpu: gpuInfo(),
    fps,
    settings: { sensitivity: p.sensitivity, fov: p.fov, rawInput: p.rawInput, resolutionScale: p.graphics.resolutionScale, menuBackground: p.graphics.menuBackground, potato: p.graphics.potato },
    errors: recentErrors(),
  };
}

// ---------------------------------------------------------------------------------------------
// Screenshot

function blank(g: CanvasRenderingContext2D, w: number, hgt: number): boolean {
  const d = g.getImageData(0, 0, w, hgt).data;
  const step = Math.max(4, Math.floor(d.length / 4 / 400)) * 4;
  for (let i = 0; i < d.length; i += step) if (d[i + 3] !== 0 && (d[i] | d[i + 1] | d[i + 2]) !== 0) return false;
  return true;
}

const toBlob = (c: HTMLCanvasElement, q: number) => new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", q));

function scaled(src: HTMLCanvasElement, s: number): HTMLCanvasElement {
  const c = h("canvas", { width: Math.max(1, Math.round(src.width * s)), height: Math.max(1, Math.round(src.height * s)) });
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * The game view as a JPEG (<= SHOT_MAX_BYTES), or null when there's nothing rendered to capture. The copy happens in a
 * requestAnimationFrame callback queued after the game's own: the WebGL drawing buffer still holds that frame.
 */
export async function captureGame(): Promise<Blob | null> {
  const src = document.getElementById("game") as HTMLCanvasElement | null;
  if (!src || !src.width || !src.height) return null;
  // Behind a frozen menu backdrop the game isn't drawn: let one frame through (ui/backdrop.ts).
  backdropFrame();
  const frame = await new Promise<HTMLCanvasElement | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 1500);
    requestAnimationFrame(() => {
      clearTimeout(timeout);
      try {
        const s = Math.min(1, SHOT_MAX_WIDTH / src.width);
        const c = h("canvas", { width: Math.max(1, Math.round(src.width * s)), height: Math.max(1, Math.round(src.height * s)) });
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g) return resolve(null);
        g.drawImage(src, 0, 0, c.width, c.height);
        resolve(blank(g, c.width, c.height) ? null : c);
      } catch {
        resolve(null);
      }
    });
  });
  if (!frame) return null;
  for (const [q, s] of [[0.82, 1], [0.7, 1], [0.62, 0.75], [0.55, 0.5]] as const) {
    const b = await toBlob(s === 1 ? frame : scaled(frame, s), q);
    if (b && b.size <= SHOT_MAX_BYTES) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Dialog: two steps. First "what's it about" as a plain list of words, like the pause menu's rail; then one box to write in, with what gets sent with it
// shown in words (the map you're on, where in the run, your browser) and a switch to leave it out, an optional
// screenshot, and where the reply will come. "Wrong map tier" (only on a map) adds a row of tiers above the box and
// makes the words optional. The moderator application is its own page, reached from a quiet line.

/** The kinds, as players say them. */
const KINDS: { id: Exclude<FeedbackCategory, "application">; title: string; head: string; mood: Mood }[] = [
  { id: "bug", title: "Something's broken", head: "Report a bug", mood: "sad" },
  { id: "physics", title: "Movement feels off", head: "Movement", mood: "surprised" },
  { id: "map", title: "A map problem", head: "Map problem", mood: "thinking" },
  { id: "tier", title: "Wrong map tier", head: "Map tier", mood: "thinking" },
  { id: "multiplayer", title: "Multiplayer", head: "Multiplayer", mood: "cheer" },
  { id: "idea", title: "An idea", head: "Share an idea", mood: "proud" },
  { id: "other", title: "Something else", head: "Send feedback", mood: "idle" },
];

/** "Chrome on Windows", "the desktop app on macOS". */
function clientWords(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  const app = /BunnyhopClient\//.test(ua);
  const browser = app ? "The desktop app" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Your browser";
  return os ? `${browser} on ${os}` : browser;
}

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(2);
  return m ? `${m}:${r.padStart(5, "0")}` : r;
};

/** Where the player is, in words: "1:23.45 into a run", "in the start zone", "watching a replay". */
function whereWords(g: Record<string, unknown>): string | null {
  const t = g.timer && typeof g.timer === "object" ? (g.timer as { status?: string; ticks?: number; inStart?: boolean }) : null;
  if (g.watchingReplay) return "Watching a replay";
  if (g.spectating) return "Spectating";
  if (g.practice) return "In practice mode";
  if (t?.inStart) return "In the start zone";
  if (t?.status === "running" && typeof t.ticks === "number") return `${clock(t.ticks / 100)} into a run`;
  if (t?.status === "finished") return "Just finished a run";
  return null;
}

export function showFeedback(o: FeedbackOpen = {}): void {
  if (current) {
    // Already open: switch it to the asked-for kind (e.g. "apply" while writing a bug report).
    if (o.category) (current as HTMLDialogElement & { pick?: (c: FeedbackCategory) => void }).pick?.(o.category);
    return;
  }
  const fps = fpsSampler();
  let shotUrl: string | null = null;
  const d = modal("acct-dialog fb-dialog", "Send feedback", () => {
    current = null;
    if (!sent && (text.value.trim() || contact.value.trim()) && category !== "application") draft = { category, text: text.value, contact: contact.value };
    fps.stop();
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    o.onClose?.();
  });
  current = d;
  // Esc steps back to the choices first, then closes (also the gamepad's synthetic Esc).
  d.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (step !== "pick" && !text.value.trim() && !answerText()) show("pick");
    else d.close();
  });

  const g = gameInfo() ?? {};
  const onMap = typeof g.map === "string" && g.inGame !== false ? (g.map as string) : null;
  // The tier kind needs a map to be about.
  const kindsHere = KINDS.filter((k) => k.id !== "tier" || onMap);
  let category: FeedbackCategory = o.category ?? draft?.category ?? "bug";
  let sent = false;
  let step: "pick" | "write" | "apply" = "pick";

  // ---- head: back, the title, close
  const title = h("h2", null, "Send feedback");
  const back = h("button.fb-back", { type: "button", "aria-label": "Back", hidden: true, onclick: () => show("pick") }, icon("chevronLeft", { size: "1.1rem" }));
  const head = h("header.acct-head.fb-head", null, back, title, h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, "×"));

  // ---- step 1: what's it about
  const kinds = h(
    "div.fb-kinds",
    { role: "list" },
    ...kindsHere.map((k, i) =>
      h(
        "button.fb-kind",
        { type: "button", role: "listitem", "data-kind": k.id, style: `--i:${i}`, onclick: () => (bun.react("hop"), pick(k.id)), onpointerenter: () => bun.set(k.mood), onfocus: () => bun.set(k.mood) },
        h("span.fb-kind-title", null, k.title),
        icon("chevronRight", { size: "1rem" }),
      ),
    ),
  );
  // Your own bunny, in your colourway, listens: its face follows the choice under the pointer.
  const bun = mascot("waving", { size: "7.5rem", colourway: getOutfit(), className: "fb-bun", label: "Your bunny" });
  kinds.addEventListener("pointerleave", () => bun.set("idle"));
  const pickPage = h(
    "div.fb-page.fb-pick",
    null,
    h("div.fb-pick-row", null, h("div.fb-pick-list", null, h("p.fb-ask", null, "What's it about?"), kinds), bun.el),
    h("p.fb-apply-line", null, "Want to help keep the servers friendly? ", h("button.fb-inline", { type: "button", onclick: () => pick("application"), onpointerenter: () => bun.set("cheer") }, "Apply to moderate")),
  );

  // ---- step 2: write it
  const text = h("textarea.fb-text", { id: "fb-text", rows: 5, maxlength: MESSAGE_MAX, required: true, "aria-label": "Your message" });
  // A report from a profile (social: ⋯ → Report) starts with who it's about.
  if (o.message) text.value = o.message;
  const count = h("small.fb-count", { "aria-live": "polite" });
  const updateCount = () => {
    const n = [...text.value.trim()].length;
    count.textContent = n > 0 && n < MESSAGE_MIN && category !== "tier" ? `${MESSAGE_MIN - n} more character${MESSAGE_MIN - n === 1 ? "" : "s"}` : n > MESSAGE_MAX - 200 ? `${MESSAGE_MAX - [...text.value].length} left` : "";
  };
  text.addEventListener("input", () => {
    updateCount();
    if (err.textContent && text.value.trim().length >= MESSAGE_MIN) err.textContent = "";
  });

  // "Wrong map tier": the map's tier in words, then the six to pick from (the current one can't be picked).
  let tierNow: number | null | undefined;
  let tierPick: number | null = null;
  const tierAsk = h("p.fb-ask");
  const tierButtons = TIERS.map((t) =>
    h("button.fb-tier", { type: "button", role: "radio", title: tierName(t), style: `--tc: var(--tier-${t})`, onclick: () => ((tierPick = t), paintTiers(), (err.textContent = "")) }, tierLabel(t)),
  );
  const tierRow = h("div.fb-tiers", { role: "radiogroup", "aria-label": "The tier it should be" }, ...tierButtons);
  const paintTiers = () => {
    tierAsk.textContent = tierNow === undefined ? `${onMap}: what tier should it be?` : tierNow ? `${onMap} is ${tierLabel(tierNow)}, ${tierName(tierNow).toLowerCase()}. What should it be?` : `${onMap} has no tier yet. What should it be?`;
    tierButtons.forEach((b, i) => {
      b.setAttribute("aria-checked", String(TIERS[i] === tierPick));
      b.disabled = TIERS[i] === tierNow;
    });
  };
  const tierPage = h("div.fb-tier-pick", { hidden: true }, tierAsk, tierRow);
  const loadTier = () => {
    if (tierNow !== undefined || !onMap) return;
    paintTiers();
    void mapTier(onMap)
      .catch(() => null)
      .then((t) => {
        tierNow = t;
        if (tierPick === t) tierPick = null;
        const lost = tierButtons.some((b) => b === document.activeElement && TIERS[tierButtons.indexOf(b)] === t);
        paintTiers();
        if (lost) tierButtons.find((b) => !b.disabled)?.focus();
      });
  };

  // What goes with it, in words, with one switch.
  let include = true;
  const ctxSwitch = h("button.fb-switch", { type: "button", role: "switch", "aria-checked": "true", "aria-label": "Send game info" }, h("span.fb-knob"));
  const ctxCard = h(
    "div.fb-ctx",
    null,
    onMap ? mapArt(onMap, null, { className: "fb-ctx-art", eager: true }) : h("span.fb-ctx-icon", null, icon("graphics", { size: "1.2rem" })),
    h(
      "div.fb-ctx-text",
      null,
      h("b", null, onMap ? `${onMap}${typeof g.style === "string" ? `, ${styleLabel(g.style)}` : ""}` : "Sent from the menu"),
      h("span", null, [onMap ? whereWords(g) : null, clientWords()].filter(Boolean).join(". ")),
    ),
    ctxSwitch,
  );
  const ctxNote = h("p.fb-ctx-note", null, onMap ? "Your map, position, settings, browser and recent errors help us find it fast. " : "Your settings, browser and recent errors help us find it fast. ", h("button.fb-inline.dim", { type: "button", onclick: () => toggleRaw() }, "See all of it"));
  const raw = h("pre.fb-preview", { hidden: true });
  const toggleRaw = () => {
    raw.hidden = !raw.hidden;
    if (!raw.hidden) raw.textContent = JSON.stringify(gameContext(fps.read()), null, 2);
  };
  ctxSwitch.addEventListener("click", () => {
    include = !include;
    ctxSwitch.setAttribute("aria-checked", String(include));
    ctxCard.classList.toggle("off", !include);
  });

  // The screenshot: a tile that becomes the picture.
  let shotBlob: Blob | null = null;
  let shotSeq = 0;
  const shotTile = h("div.fb-shot");
  const paintShot = (state: "empty" | "busy" | "none" | "done") => {
    if (state === "done" && shotUrl) {
      shotTile.replaceChildren(
        h("img", { src: shotUrl, alt: "Your screenshot" }),
        h("span.fb-shot-text", null, h("b", null, "Screenshot added"), h("span", null, "Of the game view, not your screen")),
        h("button.fb-shot-x", { type: "button", "aria-label": "Remove the screenshot", onclick: () => ((shotSeq++), (shotBlob = null), shotUrl && URL.revokeObjectURL(shotUrl), (shotUrl = null), paintShot("empty")) }, icon("close", { size: "0.9rem" })),
      );
      return;
    }
    shotTile.replaceChildren(
      h(
        "button.fb-shot-add",
        { type: "button", disabled: state === "busy", onclick: () => void takeShot() },
        icon("camera", { size: "1.15rem" }),
        h("span", null, state === "busy" ? "Taking it…" : state === "none" ? "No game view to capture here" : "Add a screenshot of the game"),
      ),
    );
  };
  const takeShot = async () => {
    const seq = ++shotSeq;
    paintShot("busy");
    const b = await captureGame();
    if (seq !== shotSeq) return;
    if (!b) return paintShot("none");
    shotBlob = b;
    shotUrl = URL.createObjectURL(b);
    paintShot("done");
  };
  paintShot("empty");

  // Where the reply goes: the Inbox; a contact only if they'd rather.
  const contact = h("input.fb-input", { id: "fb-contact", type: "text", maxlength: CONTACT_MAX, autocomplete: "off", placeholder: "Discord or email" });
  const contactRow = h("div.fb-contact", { hidden: true }, contact);
  const reply = h(
    "p.fb-reply",
    null,
    icon("mail", { size: "1rem" }),
    h("span", null, "We reply in your Inbox. "),
    h("button.fb-inline.dim", { type: "button", onclick: (e: Event) => ((contactRow.hidden = false), (e.currentTarget as HTMLElement).remove(), contact.focus()) }, "Somewhere else?"),
  );

  const writePage = h("div.fb-page.fb-write", { hidden: true }, tierPage, h("div.fb-field", null, text, count), h("div.fb-with", null, ctxCard, ctxNote, raw, shotTile), reply, contactRow);

  // ---- the moderator application (its own page)
  const answers = Object.fromEntries(
    QUESTIONS.map((q) => [
      q.key,
      q.long
        ? h("textarea.fb-text.fb-answer", { id: `fb-${q.key}`, rows: 3, maxlength: q.max, placeholder: q.placeholder })
        : h("input.fb-input", { id: `fb-${q.key}`, type: "text", maxlength: q.max, autocomplete: "off", placeholder: q.placeholder }),
    ]),
  ) as Record<(typeof QUESTIONS)[number]["key"], HTMLInputElement | HTMLTextAreaElement>;
  const nudge = h("p.fb-nudge", { hidden: true }, "You're playing as a guest. Sign in to apply. ", SIGN_IN_HELP, " ", h("button.fb-inline", { type: "button", onclick: () => (d.close(), openAccount("save")) }, "Sign in"));
  let applyReady = false;
  const prepareApply = () => {
    if (applyReady) return;
    applyReady = true;
    void me().then(async (u) => {
      if (!u || !d.isConnected) return;
      nudge.hidden = u.provider !== "guest";
      if (u.provider === "guest") return;
      const discord = (await api.account().catch(() => null))?.methods.find((m) => m.provider === "discord")?.label;
      if (discord && !answers.discord.value) answers.discord.value = discord;
    });
  };
  const applyPage = h(
    "div.fb-page.fb-applying",
    { hidden: true },
    h("p.fb-lead.dim", null, APPLY_LEAD),
    nudge,
    ...QUESTIONS.map((q) => h("label.fb-field", { for: `fb-${q.key}` }, h("span.fb-label", null, q.label), answers[q.key])),
  );
  const answerText = () => QUESTIONS.map((q) => answers[q.key].value.trim()).join("");

  // ---- footer
  const err = h("p.fb-err", { role: "alert" });
  const send = h("button.btn.primary.fb-send", { type: "submit" }, "Send");
  const actions = h("div.fb-actions", { hidden: true }, err, send);

  function show(next: typeof step): void {
    const from = step;
    step = next;
    // The page slides in from the side it comes from (forward from the right, Back from the left); the title follows.
    const page = next === "pick" ? pickPage : next === "write" ? writePage : applyPage;
    if (from !== next && !calm() && d.open) {
      const dx = next === "pick" ? -14 : 14;
      page.animate([{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: "none" }], { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      title.animate([{ opacity: 0, transform: `translateX(${dx / 2}px)` }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      actions.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, fill: "backwards" });
    }
    pickPage.hidden = next !== "pick";
    writePage.hidden = next !== "write";
    applyPage.hidden = next !== "apply";
    actions.hidden = next === "pick";
    back.hidden = next === "pick";
    err.textContent = "";
    const k = KINDS.find((x) => x.id === category);
    title.textContent = next === "pick" ? "Send feedback" : next === "apply" ? "Apply to moderate" : (k?.head ?? "Send feedback");
    send.textContent = next === "apply" ? "Send application" : "Send";
    if (next === "pick") (kinds.querySelector<HTMLElement>(`[data-kind="${category}"]`) ?? kinds.querySelector<HTMLElement>("button"))?.focus();
    if (next === "write") (category === "tier" ? (tierRow.querySelector<HTMLElement>("button:not(:disabled)") ?? text) : text).focus();
    if (next === "apply") (prepareApply(), answers.discord.focus());
  }
  function pick(id: FeedbackCategory): void {
    if (id === "tier" && !onMap) id = "map";
    category = id;
    if (id === "application") return show("apply");
    text.placeholder = PLACEHOLDER[id];
    text.required = id !== "tier";
    tierPage.hidden = id !== "tier";
    if (id === "tier") loadTier();
    updateCount();
    show("write");
  }
  (d as HTMLDialogElement & { pick?: (c: FeedbackCategory) => void }).pick = pick;

  let busy = false;
  const form = h(
    "form.fb-form",
    {
      novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (busy || step === "pick") return;
        const message = text.value;
        const applying = step === "apply";
        if (applying && [...answerText()].length < MESSAGE_MIN) {
          err.textContent = "Tell us a little about yourself first: a few words in any of the boxes.";
          answers.why.focus();
          return;
        }
        if (!applying && category === "tier" && !tierPick) {
          err.textContent = "Pick the tier you think it should be.";
          (tierRow.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
          return;
        }
        if (!applying && category !== "tier" && [...message.trim()].length < MESSAGE_MIN) {
          err.textContent = "Tell us a bit more so we can act on it.";
          text.focus();
          if (!calm()) text.animate([{ transform: "none" }, { transform: "translateX(-5px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-2px)" }, { transform: "none" }], { duration: 300, easing: "ease-out" });
          return;
        }
        busy = true;
        send.disabled = true;
        send.textContent = "Sending…";
        err.textContent = "";
        try {
          if (applying) {
            // A session to tie it to (a guest's, if nothing else; the API refuses an application without one).
            await me();
            const application = Object.fromEntries(QUESTIONS.map((q) => [q.key, answers[q.key].value.trim()]).filter(([, v]) => v));
            const r = await api.sendFeedback({ category: "application", message: "", application });
            thanks(r.id, false, true);
            return;
          }
          const tier = category === "tier" && onMap && tierPick ? { tier: { map: onMap, current: tierNow ?? null, suggested: tierPick } } : {};
          const body: FeedbackBody = { category, message, ...tier, ...(contact.value.trim() ? { contact: contact.value.trim() } : {}), ...(include ? { context: gameContext(fps.read()) } : {}) };
          const r = await api.sendFeedback(body, shotBlob);
          sent = true;
          draft = null;
          thanks(r.id, !!contact.value.trim());
        } catch (x) {
          err.textContent =
            x instanceof ApiError ? x.message : x instanceof ApiUnavailable ? "Couldn't reach the server. Check your connection and try again." : "Something went wrong. Please try again.";
          busy = false;
          send.disabled = false;
          send.textContent = applying ? "Send application" : "Send";
        }
      },
    },
    pickPage,
    writePage,
    applyPage,
    actions,
  );
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), form.requestSubmit());
  });

  const thanks = (id: string, withContact: boolean, application = false) => {
    back.hidden = true;
    title.textContent = application ? "Application sent" : "Sent";
    const close = h("button.btn.primary", { type: "button", onclick: () => d.close() }, "Close");
    // The bunny takes it, proudly, with a little hop as the card lands.
    const bun = mascot("proud", { size: "5.5rem", className: "fb-mascot" });
    form.replaceWith(
      h(
        "div.fb-thanks",
        { role: "status" },
        bun.el,
        ...(application
          ? [h("h3", null, "Thanks for applying"), h("p.dim", null, "We'll look at your account and reply in your Inbox.")]
          : [h("h3", null, "Thanks, we got it"), h("p.dim", null, withContact ? "We'll reply in your Inbox, or at the contact you gave." : "We'll reply in your Inbox.")]),
        h("p.fb-ref", null, "Reference ", h("code", null, id)),
        h("div.fb-actions", null, application ? discordLink("btn.discord") : null, close),
      ),
    );
    close.focus();
    landIn(bun.el, "translateY(16px) scale(0.9)");
    window.setTimeout(() => bun.react("hop"), 380);
  };

  d.append(head, h("div.acct-body", null, form));
  d.showModal();
  // Opened for a kind (the pause menu's map report, a profile's Report, /?apply=moderator): straight to writing. A draft
  // left from last time comes back where it was.
  const restore = draft && (!o.category || o.category === draft.category) ? draft : null;
  if (restore && !o.message) {
    text.value = restore.text;
    if (restore.contact) (contact.value = restore.contact), (contactRow.hidden = false), reply.querySelector("button")?.remove();
    draft = null;
    pick(restore.category);
    updateCount();
  } else if (o.category) pick(o.category);
  else {
    show("pick");
    // The list eases in a row at a time and the bunny lands and waves (feedback.css .fb-kinds.enter).
    if (!calm()) {
      kinds.classList.add("enter");
      landIn(bun.el, "translateY(14px) scale(0.92)");
      window.setTimeout(() => kinds.classList.remove("enter"), 700);
    }
  }
}
