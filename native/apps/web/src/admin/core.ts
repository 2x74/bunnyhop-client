// The admin panel's shared pieces: DOM helpers, formatting, the API client, who is signed in and what they may do, the
// action wrapper (toast, busy button, Undo), the confirm dialog, tables, states, links, polling that pauses in hidden
// tabs, and a per-view keyboard map. Every view module imports from here; main.ts is the shell and the router.
// Plain DOM, no game code. User-supplied text (names, chat, reasons) is only ever set with textContent.

import { glyph } from "./glyphs";
import { busy, toast, triggerOf, type ToastAction } from "./ui";
import type { Permission } from "../moderation/staff";
import type { StaffRole } from "../progression";
import { SPECIAL_BADGES, STAFF_LABEL, STAFF_SVG, staffBadgeOf } from "../creators";

export const API = ((import.meta.env.VITE_API_URL as string | undefined) || "/api").replace(/\/+$/, "");
const TOKEN_KEY = "bh_admin_token";
/** The last /admin/me answer, so the rail can paint before the next one comes back (sessionStorage: this tab only). */
const ME_KEY = "bh_admin_me";

// ---------------------------------------------------------------------------------------------
// DOM

export type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** replaceChildren that skips null / false and flattens arrays. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}
export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const phone = () => matchMedia("(max-width: 56rem)").matches;

// ---------------------------------------------------------------------------------------------
// Formatting

export const pad = (v: number) => String(v).padStart(2, "0");
export function when(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `in ${dur(-s * 1000)}`;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
/** How long something has been open: "12m", "3h", "2d". */
export function age(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
/** A run time as the HUD timer shows it: 01:43.112 (src/timer.ts formatTime). */
export function fmtTime(sec: number | null | undefined, sign = false): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const neg = sec < 0;
  let ms = Math.round(Math.abs(sec) * 1000);
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  return `${neg ? "-" : sign ? "+" : ""}${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
}
export const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString() : "0");
export const short = (id: string) => (id.length > 12 ? `${id.slice(0, 10)}…` : id);
export const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;
/** 850 ms, 2.1 s, 48 s, 2m 05s */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${pad(Math.round((ms % 60_000) / 1000))}s`;
}
export const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
/** UTC day buckets are labelled with their UTC date. */
export const dayName = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
/** "$12.50" from cents. */
export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
/** "12.5" (dollars, as typed) -> 1250 cents; null if it isn't an amount. */
export function dollarsToCents(v: string | undefined): number | null {
  const t = (v ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
/** "1.2M", "48k", "312". */
export function compact(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return v.toLocaleString();
}
/** Minutes as a duration word: "30 min", "1 hour", "7 days", "permanent". */
export function minutesWord(m: number | null | undefined): string {
  if (m === null || m === undefined) return "permanent";
  if (m < 60) return `${m} min`;
  if (m < 1440) return m % 60 ? `${(m / 60).toFixed(1)} hours` : plural(m / 60, "hour");
  return m % 1440 ? `${(m / 1440).toFixed(1)} days` : plural(m / 1440, "day");
}

// ---------------------------------------------------------------------------------------------
// API

export class NotAdmin extends Error {}

export function token(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null): void {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, { method: body === undefined ? "GET" : "POST", credentials: "include", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 404 && path.startsWith("/admin/")) {
    const e = await res.json().catch(() => ({}) as Record<string, string>);
    // requireStaff answers a bare 404 not_found; other 404s carry a message (no such player, unknown server).
    if ((e as { error?: string }).error === "not_found" && !(e as { message?: string }).message?.includes(" ")) throw new NotAdmin();
    throw new Error((e as { message?: string }).message ?? "not found");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** An admin-only image (Bearer token or cookie) as an object URL. */
export async function adminBlobUrl(path: string): Promise<string> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(API + path, { credentials: "include", headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

// ---------------------------------------------------------------------------------------------
// Who is signed in

export interface Me {
  id: string;
  name: string;
  token: boolean;
  /** Null for a Contributor without a staff role (`contributor`), who may only read Analytics. */
  role?: StaffRole | null;
  contributor?: boolean;
  perms?: Permission[];
  /** Their picture (avatar, else Discord picture), null: the letter. */
  avatar?: string | null;
}

/** A staff member or player as the cases API names them (apps/api src/admin-cases.ts Person). */
export interface Person {
  id: string;
  name: string;
  avatar: string | null;
  role?: StaffRole | null;
}

/**
 * Someone's picture, or their letter on a tone when they have none (or it fails to load). `staff`: the letter on the
 * amber wash, as in a ticket's thread. size: px.
 */
export function avatar(p: { name?: string | null; avatar?: string | null } | null | undefined, o: { size?: number; staff?: boolean; cls?: string } = {}): HTMLElement {
  const size = o.size ?? 28;
  const letter = ((p?.name ?? "?").trim()[0] ?? "?").toUpperCase();
  const cls = `av${o.staff ? " staff" : ""}${o.cls ? ` ${o.cls}` : ""}`;
  const style = size === 28 ? undefined : `width:${size}px;height:${size}px;font-size:${Math.max(9, Math.round(size * 0.42))}px`;
  const fallback = () => h("span", { class: cls, style, "aria-hidden": "true" }, letter);
  // https pictures (Discord), or the site's own (Bun-E's, /discord/bun-e.png).
  if (!p?.avatar || !/^(https:\/\/|\/[\w])/.test(p.avatar)) return fallback();
  const img = h("img", { class: cls, style, src: p.avatar, alt: "", width: size, height: size, loading: "lazy", referrerpolicy: "no-referrer", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

export let me: Me | null = null;
export function setMe(m: Me | null): void {
  me = m;
  try {
    if (m) sessionStorage.setItem(ME_KEY, JSON.stringify(m));
    else sessionStorage.removeItem(ME_KEY);
  } catch {
    /* private mode */
  }
}
/** The last known staff member in this tab (painted before /admin/me answers). */
export function cachedMe(): Me | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(ME_KEY) ?? "null") as Me | null;
    return v && typeof v.id === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Whether the signed-in staff member holds `p` (GET /admin/me perms; an API without them: everything, as before). */
export function may(p: Permission): boolean {
  return !me?.perms || me.perms.includes(p);
}

/** Every staff role may correct automatic or manual shadowbans. The API also checks target rank and reason. */
export function mayShadow(shadowed: boolean, _source: string | null | undefined): boolean {
  return may("player.shadow") && (!shadowed || may("player.unshadow.any"));
}

/** The role's word in the panel ("Owner", "Admin", "Moderator"). */
export const ROLE_WORD: Record<StaffRole, string> = { owner: "Owner", admin: "Admin", moderator: "Moderator" };

// ---------------------------------------------------------------------------------------------
// Routing hooks (main.ts owns the router)

let routeFn: () => void = () => undefined;
let authFn: () => void = () => undefined;
export function setRouter(route: () => void, auth: () => void): void {
  routeFn = route;
  authFn = auth;
}
/** Re-runs the current view (after an action that changes what it lists). */
export const reroute = () => routeFn();
export const showAuth = () => authFn();

export type View = (root: HTMLElement, params: URLSearchParams, rest: string[]) => Promise<void | (() => void)>;

// ---------------------------------------------------------------------------------------------
// Actions

/** An Undo on the toast of an action: stays 10 s (ui.ts). */
export interface Undo {
  label?: string;
  run: () => void | Promise<unknown>;
}

/**
 * POST with a toast; returns the response or null on error. The button that started it (the focused one: a dialog
 * hands focus back to its opener) shows a spinner while it runs and a check when it worked (ui.ts busy). `undo`: the
 * toast offers Undo for 10 s.
 */
export async function act<T = Record<string, unknown>>(path: string, body: unknown, done?: string, undo?: Undo | ((r: T) => Undo | undefined)): Promise<T | null> {
  try {
    const r = await busy(triggerOf(), api<T>(path, body));
    const msg = (r as { message?: string }).message;
    const u = typeof undo === "function" ? undo(r) : undo;
    if (done !== "") toast(done ?? msg ?? "Done", false, u ? ({ label: u.label ?? "Undo", run: u.run, hold: 10_000 } satisfies ToastAction) : undefined);
    return r;
  } catch (e) {
    if (e instanceof NotAdmin) return showAuth(), null;
    toast(String((e as Error).message ?? e), true);
    return null;
  }
}

/** A quiet POST for an Undo: a toast says what came back, or why it couldn't. */
export async function undoCall(path: string, body: unknown, done = "Undone"): Promise<boolean> {
  try {
    await api(path, body);
    toast(done);
    return true;
  } catch (e) {
    toast(`Couldn't undo: ${(e as Error).message}`, true);
    return false;
  }
}

/**
 * Optimistic removal: the row leaves at once (admin.css .leaving) while the request runs, and comes back if it failed
 * (the toast says why). Resolves with whether it worked.
 */
export async function leaveRow(row: Element | null | undefined, work: Promise<unknown>): Promise<boolean> {
  row?.classList.add("leaving");
  const ok = !!(await work);
  if (!ok) row?.classList.remove("leaving");
  else setTimeout(() => row?.remove(), 280);
  return ok;
}
export const rowOf = (e: Event) => (e.currentTarget as HTMLElement).closest("tr");

// ---------------------------------------------------------------------------------------------
// Dialogs

export type Field =
  | { name: string; label: string; kind: "text" | "number" | "textarea"; value?: string; placeholder?: string; required?: boolean; list?: string[] }
  | { name: string; label: string; kind: "select"; options: [string, string][]; value?: string }
  | { name: string; label: string; kind: "check"; value?: boolean }
  /** A row of quiet buttons (one pressed); `reveal`: the field shown only while this value is picked. */
  | { name: string; label: string; kind: "seg"; options: [string, string][]; value?: string; reveal?: { value: string; field: string } };

let listSeq = 0;

/** Modal confirm with optional fields. Resolves with the field values, or null when cancelled. */
export function ask(o: { title: string; text?: string; lead?: Child; fields?: Field[]; confirm?: string; danger?: boolean; wide?: boolean }): Promise<Record<string, string> | null> {
  const dlg = $<HTMLDialogElement>("dlg");
  dlg.replaceChildren();
  dlg.classList.toggle("wide", !!o.wide);
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const segs = new Map<string, () => string>();
  const form = h("form", { method: "dialog" });
  append(form, [h("h2", null, o.title), o.lead ? h("div", { class: "dlg-lead" }, o.lead) : null, o.text ? h("p", null, o.text) : null]);
  const wraps = new Map<string, HTMLElement>();
  for (const f of o.fields ?? []) {
    if (f.kind === "seg") {
      let cur = f.value ?? f.options[0]?.[0] ?? "";
      const row = h("div", { class: "seg dlg-seg", role: "radiogroup", "aria-label": f.label });
      const paint = () => {
        for (const b of row.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-checked", String(b.value === cur));
        if (f.reveal) {
          const w = wraps.get(f.reveal.field);
          if (w) w.hidden = cur !== f.reveal.value;
        }
      };
      for (const [v, l] of f.options)
        row.append(
          h("button", { type: "button", role: "radio", value: v, onclick: () => ((cur = v), paint(), f.reveal && cur === f.reveal.value && (inputs.get(f.reveal.field) as HTMLElement | undefined)?.focus()) }, l),
        );
      segs.set(f.name, () => cur);
      form.append(h("div", { class: "field" }, h("span", null, f.label), row));
      queueMicrotask(paint);
      continue;
    }
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (f.kind === "select") input = h("select", { name: f.name }, f.options.map(([v, l]) => h("option", { value: v, selected: v === f.value }, l)));
    else if (f.kind === "textarea") input = h("textarea", { name: f.name, placeholder: f.placeholder, value: f.value ?? "" });
    else if (f.kind === "check") input = h("input", { type: "checkbox", name: f.name, checked: !!f.value });
    else {
      const listId = f.list?.length ? `dl-${++listSeq}` : undefined;
      input = h("input", { type: f.kind, name: f.name, placeholder: f.placeholder, value: f.value ?? "", required: f.required, min: f.kind === "number" ? "1" : undefined, list: listId, autocomplete: "off" });
      if (listId) form.append(h("datalist", { id: listId }, f.list!.map((x) => h("option", { value: x }))));
    }
    inputs.set(f.name, input);
    const wrap = f.kind === "check" ? h("label", { class: "field check" }, input, f.label) : h("label", { class: "field" }, f.label, input);
    wraps.set(f.name, wrap);
    form.appendChild(wrap);
  }
  const cancel = h("button", { type: "button", value: "cancel" }, "Cancel");
  const ok = h("button", { type: "submit", value: "ok", class: o.danger ? "danger" : "primary" }, o.confirm ?? "Confirm");
  form.appendChild(h("div", { class: "actions" }, cancel, ok));
  dlg.appendChild(form);
  return new Promise((resolve) => {
    let result: Record<string, string> | null = null;
    cancel.onclick = () => dlg.close();
    form.onsubmit = (e) => {
      e.preventDefault();
      result = {};
      for (const [k, el] of inputs) {
        if (wraps.get(k)?.hidden) continue;
        result[k] = el instanceof HTMLInputElement && el.type === "checkbox" ? (el.checked ? "1" : "") : el.value.trim();
      }
      for (const [k, get] of segs) result[k] = get();
      dlg.close();
    };
    dlg.addEventListener("close", () => resolve(result), { once: true });
    dlg.showModal();
    (form.querySelector("input:not([type=checkbox]), select, textarea, .seg button[aria-checked=true]") as HTMLElement | null)?.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// Tables, states, links

export function table(head: (string | [string, string])[], rows: HTMLTableRowElement[], empty = "Nothing here."): HTMLElement {
  return h(
    "div",
    { class: "tablewrap" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, head.map((c) => (Array.isArray(c) ? h("th", { class: c[1] }, c[0]) : h("th", null, c))))),
      h("tbody", null, rows.length ? rows : h("tr", null, h("td", { colspan: String(head.length), class: "empty" }, empty))),
    ),
  );
}

/** A state: a word with a mark (never a pill). kind: ok | bad | warn | acc | info | "". */
export const badge = (text: string, kind = "") => h("span", { class: `badge ${kind}` }, text);

/** Which client played a run (apps/api src/run-client.ts, staff endpoints only): "Native 0.6.2", "Desktop 0.2.2", "Chrome 156". The tooltip has the user agent and build. */
export interface RunClient {
  kind: "native" | "desktop" | "browser" | "unknown";
  label: string;
  title: string;
}
export const clientTag = (c: RunClient | null | undefined): HTMLElement | null => (c ? h("span", { class: "faint client-tag", title: c.title }, c.label) : null);
export const timeCell = (ms: number | null | undefined) => h("td", { class: "time", title: when(ms) }, ago(ms));
/** A run time in the timer's type. */
export const timeEl = (sec: number | null | undefined, cls = "") => h("span", { class: `t-run ${cls}` }, fmtTime(sec));

export function idCell(id: string): HTMLElement {
  return h("span", { class: "mono faint id", title: `${id} (click to copy)`, onclick: () => void navigator.clipboard?.writeText(id).then(() => toast("Copied id"), () => toast("Couldn't copy: the browser refused", true)) }, short(id));
}

/**
 * A player's name. A plain click opens the player drawer (drawer.ts, installed by main.ts); a modified click, a middle
 * click or a new tab opens the full page.
 */
export const playerLink = (id: string, name: string | null) => h("a", { href: `#/player/${encodeURIComponent(id)}`, class: "pl", "data-player": id }, name || id);

/** The staff shield players see next to a name (creators.ts STAFF_SVG: the owner's is Owner). */
export function staffShield(role: StaffRole | null | undefined): HTMLElement | null {
  const b = staffBadgeOf(role);
  if (!b) return null;
  const el = h("span", { class: `staff-mark ${b}`, role: "img", "aria-label": STAFF_LABEL[b], title: STAFF_LABEL[b] });
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${STAFF_SVG[b]}</svg>`;
  return el;
}

export function specialIcon(id: string, size = 16): HTMLElement {
  const def = SPECIAL_BADGES[id];
  const el = h("span", { class: "special-icon", "aria-hidden": "true" });
  if (def) el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${def.svg}</svg>`;
  return el;
}

/** A title with its long explanation behind a "?" (a popover on press, Esc or a click elsewhere closes it). */
export function help(text: string): HTMLElement {
  const tip = h("span", { class: "help-tip", role: "tooltip", hidden: true }, text);
  const btn = h("button", { type: "button", class: "help", "aria-label": "What is this?", "aria-expanded": "false" }, "?");
  const wrap = h("span", { class: "help-wrap" }, btn, tip);
  const close = () => ((tip.hidden = true), btn.setAttribute("aria-expanded", "false"), document.removeEventListener("pointerdown", outside, true));
  const outside = (e: Event) => !wrap.contains(e.target as Node) && close();
  btn.onclick = () => {
    if (!tip.hidden) return close();
    tip.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
  };
  wrap.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), close()));
  return wrap;
}

/** The empty line of a list: one plain sentence. */
export const emptyLine = (text: string) => h("p", { class: "empty-line" }, text);

/** Label / value lines (instead of middot chains). */
export function kv(pairs: [string, Child][]): HTMLElement {
  return h("dl", { class: "kv" }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== false && v !== "").flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
}

// ---------------------------------------------------------------------------------------------
// Shared data

export interface ServerRow {
  id: string;
  name: string;
  region: string;
  maxPlayers: number;
  players: number;
  online: boolean;
  map: string | null;
  tier: number | null;
  timeLeftMs: number | null;
  changing: string | null;
  timeLimitMinutes?: number;
}

export interface ChatRow {
  id: number;
  room_id: string;
  map: string | null;
  user_id: string;
  name: string;
  raw: string;
  shown: string | null;
  filtered: number;
  blocked: number;
  muted: number;
  command: number;
  dropped: string | null;
  ip_hash?: string | null;
  created_at: number;
}

export interface ModRow {
  id: number;
  actor_id: string;
  actor_name: string | null;
  action: string;
  target_user?: string | null;
  target_name: string | null;
  room_id: string | null;
  source: string;
  details: string | null;
  created_at: number;
  /** GET /admin/log only: the actor's role today and whether the row was undone. */
  actor_role?: StaffRole | null;
  undone_at?: number | null;
  undone_by?: string | null;
}

let roomList: { id: string; name: string }[] = [];
export async function rooms(): Promise<{ id: string; name: string }[]> {
  if (!roomList.length) {
    try {
      roomList = (await fetch(`${API}/servers`).then((r) => r.json() as Promise<ServerRow[]>)).map((r) => ({ id: r.id, name: r.name }));
    } catch {
      roomList = [];
    }
  }
  return roomList;
}

// ---------------------------------------------------------------------------------------------
// Polling: never while the tab is hidden (a forgotten admin tab costs nothing); a tab coming back refreshes at once if
// it missed a beat.

export function poll(fn: () => Promise<unknown> | void, ms: number): () => void {
  let last = Date.now();
  let timer = 0;
  let stopped = false;
  const run = () => {
    if (stopped || document.hidden) return;
    last = Date.now();
    void Promise.resolve(fn()).catch(() => undefined);
  };
  const arm = () => {
    clearInterval(timer);
    timer = window.setInterval(run, ms);
  };
  const vis = () => {
    if (document.hidden) return clearInterval(timer);
    if (Date.now() - last >= ms) run();
    arm();
  };
  document.addEventListener("visibilitychange", vis);
  if (!document.hidden) arm();
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", vis);
  };
}

// ---------------------------------------------------------------------------------------------
// Keys: a view registers single-letter keys (j / k, c, i ...) for while it is on screen. Never while typing or with a
// dialog open; main.ts clears them on every route change.

type KeyMap = Record<string, (e: KeyboardEvent) => void>;
let keys: KeyMap = {};
let keyHelp: [string, string][] = [];
/** The view's keys, and what they do in words for the ? sheet (shortcuts.ts). */
export function setKeys(map: KeyMap, help: [keys: string, what: string][] = []): void {
  keys = map;
  keyHelp = help;
}
export function clearKeys(): void {
  keys = {};
  keyHelp = [];
}
export const viewKeyHelp = () => keyHelp;
if (typeof document !== "undefined") document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const t = e.target as HTMLElement;
  if (t.closest?.("input, textarea, select, [contenteditable=true]") || document.querySelector("dialog[open]")) return;
  if (document.body.classList.contains("goto")) return;
  // Enter on a focused link or button is the link's or the button's (a player's name opens the drawer), not the view's.
  if (e.key === "Enter" && t.closest?.("a[href], button")) return;
  const fn = keys[e.key] ?? keys[e.key.toLowerCase()];
  if (!fn) return;
  e.preventDefault();
  fn(e);
});

/** Moves the focus mark (class "cur") through `rows` by `step`, scrolls it into view, and returns the new row. */
export function stepRows(rows: HTMLElement[], step: number): HTMLElement | null {
  if (!rows.length) return null;
  const i = rows.findIndex((r) => r.classList.contains("cur"));
  const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + step))];
  rows.forEach((r) => r.classList.toggle("cur", r === next));
  next.scrollIntoView({ block: "nearest" });
  return next;
}

export { glyph, toast };
