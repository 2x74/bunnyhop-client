// In-room HUD widgets: chat (inside the movable "chat" HUD element), the Tab scoreboard, the CS:S-style numbered
// menu (map votes, spectate list, nominations), a centre banner (map change countdown) and the spectator bar.
// All text is set with textContent: chat from other players never becomes markup.

import "./net.css";
import { clear, h } from "../ui/dom";
import type { RankTag } from "./protocol";
import type { PlayerMarks } from "../creators";
import { countryFlag } from "../ui/country-flag";
import { nameAttrs, nameMarks } from "../ui/marks";
import { hopKeyframes, hopOffKeyframes } from "../notify/spring";

const MAX_LINES = 60;
const LINE_MS = 12_000;

export interface ChatLineOpts extends PlayerMarks {
  kind: "say" | "server" | "admin" | "private" | "announce" | "local";
  text: string;
  name?: string;
  /** The speaker's slot colour, for the name (a supporter's name look, `nameColor` / `nameEffect`, wins). */
  slotColor?: string;
  rank?: RankTag | null;
  /** announce: wr | sr | top10 | pb */
  tone?: string;
  /** The line as nodes (e.g. one accented number) instead of `text`; `text` stays its plain version. */
  rich?: (string | Node)[];
  /** How long it stays up before fading (default LINE_MS). */
  ms?: number;
}

/** Our own links in chat (a map, a replay, a profile, a lobby invite) become clickable; nothing else is ever a link. */
const SITE_LINK = /\bhttps?:\/\/(?:www\.)?bunnyhop\.lol(\/[^\s]*)?/gi;
const SITE_PATH = /^\/(?:maps\/[\w.-]{1,64}|replay\/[\w-]{1,64}|u\/[\w-]{1,64}|\?lobby=[a-z2-7]{10})$/i;

export function linkify(text: string): (string | Node)[] {
  const out: (string | Node)[] = [];
  let at = 0;
  for (const m of text.matchAll(SITE_LINK)) {
    const path = m[1] ?? "/";
    if (!SITE_PATH.test(path)) continue;
    out.push(text.slice(at, m.index));
    out.push(h("a.chat-link", { href: new URL(path, location.origin).toString(), rel: "noopener" }, m[0]));
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  return out.filter((x) => x !== "");
}

/** Help lines stay up long enough to read. */
const LONG_LINE_MS = 30_000;

/** A command's answer (chat-commands.ts ctx.reply): a local line, with an optional bold label (!help's groups). */
export function localLine(text: string, o?: { label?: string; long?: boolean }): ChatLineOpts {
  return { kind: "local", text, rich: o?.label ? [h("b.chat-label", null, o.label), " ", text] : undefined, ms: o?.long ? LONG_LINE_MS : undefined };
}

/** The page's chat box (one per page: solo-chat.ts or net/mp.ts), for postLocalLine. */
let current: ChatBox | null = null;

/**
 * A local system line in the chat log, only you see it (what a command's ctx.reply writes), from anywhere: e.g. the
 * jump stats line (ssj/). False when the page has no chat (the tutorial).
 */
export function postLocalLine(text: string, rich?: (string | Node)[]): boolean {
  current?.add({ kind: "local", text, rich });
  return !!current;
}

const HISTORY_KEY = "bunnyhop:chat-history";
const HISTORY_MAX = 50;

/**
 * Chat log + input, rendered into the HUD's chat element (hud.chatEl). Y opens, Enter sends, Esc closes, Up / Down go
 * through what you sent before (kept for the tab's session, so it survives map changes), Tab completes a command.
 */
export class ChatBox {
  readonly lines = h("div.chat-lines", { role: "log", "aria-live": "polite" });
  readonly input: HTMLInputElement;
  private form: HTMLFormElement;
  /** Matching commands under the input while typing one (chat-commands.ts suggestChat). */
  private hint = h("div.chat-hint", { hidden: true });
  private history = loadHistory();
  /** Position in history while browsing it (history.length = the line being typed). */
  private at = 0;
  private draft = "";
  onSend: (text: string) => void = () => {};
  onClose: () => void = () => {};
  /** Command usages matching what's typed so far ("!s" → ["!setstart", "!spec [player]"]). */
  suggest: (text: string) => string[] = () => [];

  constructor(private container: HTMLElement, placeholder = "say…  (Enter to send, Esc to close)") {
    this.input = h("input.chat-input", { type: "text", maxlength: 128, autocomplete: "off", spellcheck: false, "aria-label": "Chat message", placeholder });
    this.form = h("form.chat-form", { hidden: true }, h("span.chat-prompt", null, "Say:"), this.input);
    container.append(this.lines, this.form, this.hint);
    current = this;
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = this.input.value.trim();
      this.input.value = "";
      if (t) this.remember(t);
      // Closed first: a command's answer (or a restart) lands with the chat already out of the way.
      this.close();
      if (t) this.onSend(t);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        this.browse(e.key === "ArrowUp" ? -1 : 1);
      } else if (e.key === "Tab") {
        // Tab would move the focus (and close the chat): complete the first suggested command instead.
        e.preventDefault();
        const first = this.suggest(this.input.value)[0];
        if (first) this.setValue(`${first.split(" ")[0]} `);
      }
      e.stopPropagation(); // typing is not game input (input.ts also ignores text fields)
    });
    this.input.addEventListener("input", () => this.updateHint());
    this.input.addEventListener("blur", () => this.close());
    // The cursor is free while the chat is open (free-cursor.ts): scrolling or clicking the log keeps the chat open
    // (a click on the game closes it and resumes, through the blur).
    container.addEventListener("mousedown", (e) => this.isOpen && e.target !== this.input && e.preventDefault());
  }

  get isOpen(): boolean {
    return !this.form.hidden;
  }

  open(prefill = ""): void {
    this.form.hidden = false;
    this.container.classList.add("chat-open");
    this.lines.scrollTop = this.lines.scrollHeight;
    this.at = this.history.length;
    this.draft = "";
    this.setValue(prefill);
    // After the keydown that opened us, so its character isn't typed.
    requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
  }

  close(): void {
    if (this.form.hidden) return;
    this.form.hidden = true;
    this.hint.hidden = true;
    this.container.classList.remove("chat-open");
    this.input.blur();
    this.onClose();
  }

  private setValue(v: string): void {
    this.input.value = v;
    this.input.setSelectionRange(v.length, v.length);
    this.updateHint();
  }

  private updateHint(): void {
    const s = this.isOpen ? this.suggest(this.input.value) : [];
    this.hint.hidden = !s.length;
    this.hint.textContent = s.join("   ");
  }

  private browse(dir: -1 | 1): void {
    const next = Math.max(0, Math.min(this.history.length, this.at + dir));
    if (next === this.at) return;
    if (this.at === this.history.length) this.draft = this.input.value;
    this.at = next;
    this.setValue(next === this.history.length ? this.draft : this.history[next]);
  }

  private remember(t: string): void {
    if (this.history[this.history.length - 1] !== t) this.history.push(t);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    } catch {
      // storage blocked: history lasts for this page
    }
  }

  add(o: ChatLineOpts): void {
    const line = h(`div.chat-line.${o.kind}${o.tone ? `.tone-${o.tone}` : ""}`);
    if (o.kind === "say" && o.name) {
      if (o.rank) line.append(h("span.chat-tag", { style: `--rc:${o.rank.color}` }, o.rank.name));
      line.append(h("b.chat-name", nameAttrs(o, o.slotColor), o.name));
      // Staff shield / Verified check / creator icon / booster gem / supporter badge (compact), from the room: the
      // same marks as the boards and profiles, so staff read the same everywhere.
      const marks = nameMarks(o);
      if (marks) line.append(" ", marks);
      line.append(": ");
    } else if (o.kind === "server") line.append(h("span.chat-sys", null, "» "));
    else if (o.kind === "admin") line.append(h("span.chat-sys", null, "ADMIN » "));
    else if (o.kind === "private") line.append(h("span.chat-sys", null, "(to you) "));
    line.append(...(o.rich ?? (o.kind === "say" ? linkify(o.text) : [o.text])));
    // Open and scrolled back: stay on what's being read; else follow the newest line.
    const l = this.lines;
    const follow = !this.isOpen || l.scrollHeight - l.scrollTop - l.clientHeight < 4;
    l.append(line);
    if (follow) l.scrollTop = l.scrollHeight;
    while (this.lines.childElementCount > MAX_LINES) this.lines.firstElementChild!.remove();
    setTimeout(() => line.classList.add("old"), o.ms ?? LINE_MS);
  }
}

function loadHistory(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  detail?: string;
  disabled?: boolean;
  selected?: boolean;
}

export interface MenuSpec {
  title: string;
  items: MenuItem[];
  footer?: string;
  /** Key 0 label (default "Exit"). */
  exit?: string;
  onPick: (index: number) => void;
  onExit?: () => void;
}

/** CS:S radio-style numbered menu on the left of the screen: keys 1-9 pick, 0 exits. */
export class NumberMenu {
  readonly el = h("div#mp-menu", { hidden: true, role: "menu" });
  private spec: MenuSpec | null = null;
  readonly id = { current: "" };

  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }

  get open(): boolean {
    return !!this.spec;
  }

  show(id: string, spec: MenuSpec): void {
    this.id.current = id;
    this.spec = spec;
    this.render();
    this.el.hidden = false;
  }

  /** Re-render if `id` is the open menu (e.g. vote counts changed). */
  update(id: string, spec: MenuSpec): void {
    if (this.id.current === id && this.spec) {
      this.spec = spec;
      this.render();
    }
  }

  hide(id?: string): void {
    if (id && this.id.current !== id) return;
    this.spec = null;
    this.id.current = "";
    this.el.hidden = true;
  }

  private render(): void {
    const s = this.spec!;
    clear(this.el,
      h("div.mm-title", null, s.title),
      ...s.items.map((it, i) =>
        h(
          `div.mm-item${it.disabled ? ".off" : ""}${it.selected ? ".sel" : ""}`,
          { role: "menuitem" },
          h("span.mm-key", null, `${i + 1}.`),
          h("span.mm-label", null, it.label),
          it.detail ? h("span.mm-detail", null, it.detail) : null,
        ),
      ),
      s.footer ? h("div.mm-footer", null, s.footer) : null,
      h("div.mm-item.exit", null, h("span.mm-key", null, "0."), h("span.mm-label", null, s.exit ?? "Exit")),
    );
  }

  /** Digit key while open. Returns true if consumed. */
  key(digit: number): boolean {
    const s = this.spec;
    if (!s) return false;
    if (digit === 0) {
      this.hide();
      s.onExit?.();
      return true;
    }
    const it = s.items[digit - 1];
    if (!it || it.disabled) return true;
    s.onPick(digit - 1);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------

export interface ScoreRow extends PlayerMarks {
  slot: number;
  you: boolean;
  name: string;
  color: string;
  rank: RankTag | null;
  role: StaffRole | null;
  style: string;
  /** "0:12.345", "start", "—", "SPEC → name" */
  status: string;
  statusKind: "running" | "finished" | "idle" | "spec";
  pb: number | null;
  ping: number | null;
  /** A private lobby's host (net/lobby.ts). */
  host?: boolean;
  /** Profile flag (countries.ts code), before the name as on the boards. */
  country?: string | null;
}

export interface ScoreHead {
  room: string;
  map: string;
  tier: number | null;
  timeLeft: string;
  players: number;
  max: number;
  nextMap: string | null;
  /** You're spectating: the footer has the spectator's keys. */
  spectating?: boolean;
}

/** Tab scoreboard. */
export class Scoreboard {
  readonly el = h("div#mp-scoreboard", { hidden: true, role: "dialog", "aria-label": "Scoreboard" });

  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(on: boolean): void {
    this.el.hidden = !on;
  }

  render(head: ScoreHead, rows: ScoreRow[]): void {
    const playing = rows.filter((r) => r.statusKind !== "spec");
    const spec = rows.filter((r) => r.statusKind === "spec");
    const row = (r: ScoreRow, i: number) =>
      h(
        `tr${r.you ? ".you" : ""}`,
        null,
        h("td.sb-pos", null, String(i + 1)),
        h(
          "td.sb-name",
          null,
          h("i.sb-dot", { style: `background:${r.color}` }),
          r.rank ? h("span.chat-tag", { style: `--rc:${r.rank.color}` }, r.rank.name) : null,
          countryFlag(r.country),
          h("span.sb-pname", nameAttrs(r), r.name),
          nameMarks(r),
          r.host ? h("span.sb-host", { title: "Lobby host" }, "host") : null,
        ),
        h("td.sb-style", null, styleLabel(r.style)),
        h(`td.sb-time.${r.statusKind}`, null, r.status),
        h("td.sb-pb", null, r.pb === null ? "—" : formatTime(r.pb)),
        h("td.sb-ping", null, r.ping === null ? "—" : String(r.ping)),
      );
    clear(this.el,
      h(
        "div.sb-head",
        null,
        h("div.sb-room", null, h("b", null, head.room), h("span.dim", null, ` · ${head.players}/${head.max} players`)),
        h(
          "div.sb-map",
          null,
          h("b", null, head.map),
          head.tier ? h(`span.badge.tier.t${head.tier}`, null, `T${head.tier}`) : null,
          h("span.dim", null, ` · ${head.timeLeft}`),
          head.nextMap ? h("span.dim", null, ` · next: ${head.nextMap}`) : null,
        ),
      ),
      h(
        "table.sb-table",
        null,
        h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Player"), h("th", null, "Style"), h("th", null, "Time"), h("th", null, "PB"), h("th", null, "Ping"))),
        h("tbody", null, ...playing.map(row)),
      ),
      spec.length ? h("div.sb-spec", null, h("span.dim", null, "Spectating: "), spec.map((r) => `${r.name}${r.status.replace(/^SPEC/, "")}`).join(", ")) : null,
      h("div.sb-hint.dim", null, head.spectating ? "Mouse 1 and 2 switch players. Space changes the camera. R respawns you." : "Y to chat, N to spectate. Type rtv, nominate or timeleft. Esc has the server menu."),
    );
  }
}

/**
 * Centre band for lasting room states (connecting, map change countdown, disconnected, the race's opponent line);
 * records are notify banners. It hops in (a short arc and a squash, notify/spring.ts) when it appears, hops off when it
 * goes, and holds still while its text changes (a countdown).
 */
export class Banner {
  readonly el = h("div#mp-banner", { hidden: true, role: "status", "aria-live": "polite" });
  private leaving: Animation | null = null;

  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }

  set(text: string | null, sub?: string, tone = ""): void {
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!text) {
      if (this.el.hidden || this.leaving) return;
      if (calm) {
        this.el.hidden = true;
        return;
      }
      const a = (this.leaving = this.el.animate(hopOffKeyframes(10), { duration: 220, easing: "linear" }));
      a.finished.then(() => {
        if (this.leaving === a) (this.el.hidden = true), (this.leaving = null);
      }, () => {});
      return;
    }
    const appearing = this.el.hidden || !!this.leaving;
    this.leaving?.cancel();
    this.leaving = null;
    this.el.className = tone ? `tone-${tone}` : "";
    clear(this.el, h("div.bn-main", null, text), sub ? h("div.bn-sub", null, sub) : null);
    this.el.hidden = false;
    if (appearing && !calm) this.el.animate(hopKeyframes(-14, 6), { duration: 300, easing: "linear" });
  }
}

/** While spectating: one line at the bottom, "Watching hopper" in their colour. Their speed and timer are in your HUD. */
export class SpecBar {
  readonly el = h("div#mp-specbar", { hidden: true });
  private shown = "";

  constructor(parent: HTMLElement) {
    parent.append(this.el);
  }

  set(o: { name: string; color: string; waiting?: boolean } | null): void {
    const key = o ? `${o.name}|${o.color}|${o.waiting ? 1 : 0}` : "";
    if (key === this.shown) return;
    this.shown = key;
    if (!o) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    clear(this.el, "Watching ", h("b", { style: `color:${o.color}` }, o.name), o.waiting ? h("span.dim", null, ", waiting for them") : null);
  }
}
