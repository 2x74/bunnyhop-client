// The console on screen (console/exec.ts runs the commands): the console key (Settings → Keys → Console, ` by default)
// opens it anywhere on the page, menus included, never while typing in a text field. A plain panel at the top of the
// screen like Source's: scrollback, one line to type in, ↑ / ↓ history, Tab completion. Pasting several lines
// imports them as a config (exec.ts ConsoleRunner.paste: a report, cfg_undo).
//
// In game it acts like a menu: opening it releases the pointer (the game pauses, keys are released, Hold jump (toggle)
// ends), and closing it goes back into the game if that's where it was opened. It's a <dialog open>, so Esc closes it
// and nothing behind it (the pause menu, play-lock.ts) sees the keys typed into it.

import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { prefs, type Action } from "../ui/settings";
import { isTextField } from "../input";
import { complete, ConsoleRunner, setConfigNames, type ConfigStore, type LineKind } from "./exec";
import "./console.css";

const HISTORY_KEY = "bunnyhop:console-history";
const HISTORY_MAX = 50;
const SCROLLBACK_MAX = 600;

export interface ConsoleHooks {
  /** The game is playing (pointer locked or the chat's free cursor): opening pauses it. */
  playing?(): boolean;
  /** Pauses for the console (releases the pointer). */
  pause?(): void;
  /** Back into the game after the console closes (play-lock.ts resumePlay). */
  resume?(): void;
  /** Runs a chat command line in the current map (solo or room); false outside a map. */
  chat?(line: string, reply: (text: string) => void): boolean;
  /** Runs a bound action in the current map; false outside a map. */
  action?(a: Action): boolean;
  /** A short line for the player in game (a chat key that couldn't send, a key's command error). */
  notice?(text: string): void;
  /** `retry`: reload this map; false outside a map. */
  retry?(): boolean;
  /** `map <name>`: open that map (main menu or game). */
  openMap?(name: string): void;
  /** `disconnect` / `quit`: back to the main menu; false when already there. */
  menu?(): boolean;
  /** Map names for `map`'s completion and checks (loaded when the console first opens). */
  maps?(): Promise<string[]>;
}

let hooks: ConsoleHooks = {};
let view: ConsoleView | null = null;

/** Hooks (main.ts: the page's at startup, the map's once it runs); later calls add to / replace earlier ones. */
export function setConsoleHooks(h: ConsoleHooks): void {
  hooks = { ...hooks, ...h };
}

/** Saved configs (host_writeconfig / exec) in localStorage, `bunnyhop:cfg:<name>`. */
const CFG_PREFIX = "bunnyhop:cfg:";
const CFG_MAX = 20;
const CFG_BYTES = 32_000;
export const localConfigs: ConfigStore = {
  list() {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(CFG_PREFIX)) out.push(k.slice(CFG_PREFIX.length));
      }
    } catch {
      /* private mode */
    }
    return out.sort();
  },
  get(name) {
    try {
      return localStorage.getItem(CFG_PREFIX + name);
    } catch {
      return null;
    }
  },
  set(name, text) {
    if (text.length > CFG_BYTES) return "That config is too big to save.";
    if (!this.list().includes(name) && this.list().length >= CFG_MAX) return `There are ${CFG_MAX} saved configs already; overwrite one.`;
    try {
      localStorage.setItem(CFG_PREFIX + name, text);
      setConfigNames(this.list());
      return null;
    } catch {
      return "This browser didn't let the config be saved.";
    }
  },
};

/** The console is open. */
export const consoleOpen = (): boolean => !!view?.isOpen;

/** Opens the console (Settings → Keys → Open console). */
export function openConsole(): void {
  (view ??= new ConsoleView()).open();
}

/**
 * A command bind's once-command (input.ts onCommand: `say gg`, `slot1`, `toggle cl_showpos 0 1`), run without
 * opening the console; what it prints lands in the console's scrollback.
 */
export function runBoundCommand(command: string): void {
  (view ??= new ConsoleView()).runBound(command);
}

/** Installs the console key. Call once at startup. */
export function initConsole(): void {
  addEventListener(
    "keydown",
    (e) => {
      const keys = prefs.get().binds.console ?? [];
      if (!keys.includes(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
      // Settings → Keys is listening for a key to bind: that key is theirs.
      if (document.querySelector(".bind.capturing")) return;
      const own = view?.owns(e.target);
      if (!own && isTextField(e.target)) return; // typing in the chat or a search box
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      (view ??= new ConsoleView()).toggle();
    },
    true,
  );
}

class ConsoleView {
  readonly el: HTMLDialogElement;
  private log: HTMLElement;
  private input: HTMLInputElement;
  private runner: ConsoleRunner;
  private history: string[] = [];
  private at = -1;
  private draft = "";
  private fromGame = false;
  private greeted = false;
  /** Map names (hooks.maps), for `map`. */
  private maps: string[] = [];

  constructor() {
    this.log = h("div.con-log", { role: "log", "aria-live": "polite" });
    this.input = h("input.con-input", { type: "text", spellcheck: "false", autocomplete: "off", "aria-label": "Console command", placeholder: "help, bind, sensitivity… paste a config to import it" }) as HTMLInputElement;
    const close = h("button.acct-close.con-close", { type: "button", "aria-label": "Close the console", onclick: () => this.close() }, icon("close"));
    const run = h("button.btn.btn-sm.con-run", { type: "button", onclick: () => this.submit() }, "Run");
    this.el = h(
      "dialog.con",
      { "aria-label": "Console" },
      h("div.con-head", null, h("h2", null, "Console"), close),
      this.log,
      h("form.con-line", { onsubmit: (e: Event) => (e.preventDefault(), this.submit()) }, h("span.con-prompt", { "aria-hidden": "true" }, "]"), this.input, run),
    ) as HTMLDialogElement;
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
      if (Array.isArray(saved)) this.history = saved.filter((x): x is string => typeof x === "string").slice(-HISTORY_MAX);
    } catch {
      /* none */
    }
    this.runner = new ConsoleRunner({
      get: () => prefs.get(),
      update: (fn) => prefs.update(fn),
      print: (t, k) => this.print(t, k),
      clear: () => this.log.replaceChildren(),
      chat: (line, reply) => hooks.chat?.(line, reply) ?? false,
      action: (a) => hooks.action?.(a) ?? false,
      notice: (t) => hooks.notice?.(t),
      retry: () => hooks.retry?.() ?? false,
      menu: () => hooks.menu?.() ?? false,
      configs: localConfigs,
      openMap: (name) => {
        const m = name.trim().toLowerCase();
        if (!/^[\w.-]{1,64}$/.test(m)) return `"${name}" isn't a map name.`;
        if (this.maps.length && !this.maps.includes(m)) {
          const near = this.maps.filter((x) => x.includes(m)).slice(0, 4);
          return `No map named ${m}.${near.length ? ` Did you mean ${near.join(", ")}?` : ""}`;
        }
        if (!hooks.openMap) return "Maps open from the game.";
        this.print(`Opening ${m}…`, "dim");
        hooks.openMap(m);
        return null;
      },
    });
    setConfigNames(localConfigs.list());
    // Nothing typed here reaches the game or the menus; Esc closes.
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") return void (e.preventDefault(), this.close());
      if (e.target !== this.input) return;
      if (e.key === "Tab") return void (e.preventDefault(), this.tab());
      if (e.key === "ArrowUp" || e.key === "ArrowDown") return void (e.preventDefault(), this.recall(e.key === "ArrowUp" ? -1 : 1));
    });
    this.el.addEventListener("keyup", (e) => e.stopPropagation());
    this.input.addEventListener("paste", (e) => {
      const text = (e as ClipboardEvent).clipboardData?.getData("text") ?? "";
      if (!/[\r\n]/.test(text.trim())) return; // one line: pasted into the box as usual
      e.preventDefault();
      this.print(`Pasted ${text.trim().split(/\r?\n/).length} lines.`, "dim");
      this.runner.paste(text);
    });
    // Losing the game's pointer to the pause menu moves focus there: keep it here.
    document.addEventListener("pointerlockchange", () => this.isOpen && this.focusSoon());
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /** `t` is inside the console (its own key closes it from the input). */
  owns(t: EventTarget | null): boolean {
    return t instanceof Node && this.el.contains(t);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen) return this.focusSoon();
    this.fromGame = !!hooks.playing?.();
    if (this.fromGame) hooks.pause?.();
    if (!this.el.isConnected) document.body.append(this.el);
    this.el.show();
    if (!this.maps.length) void hooks.maps?.().then((m) => (this.maps = m.map((x) => x.toLowerCase()).sort())).catch(() => {});
    if (!this.greeted) {
      this.greeted = true;
      this.print("Source-style console. help lists the commands, find searches, Tab completes.", "dim");
    }
    this.focusSoon();
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.close();
    this.input.blur();
    if (this.fromGame) {
      this.fromGame = false;
      hooks.resume?.();
    }
  }

  private focusSoon(): void {
    this.input.focus({ preventScroll: true });
    setTimeout(() => this.isOpen && this.input.focus({ preventScroll: true }), 60);
  }

  print(text: string, kind: LineKind = "out"): void {
    for (const t of text.split("\n")) this.log.append(h(`div.con-l.${kind}`, null, t));
    while (this.log.childElementCount > SCROLLBACK_MAX) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  runBound(command: string): void {
    this.runner.runBound(command);
  }

  private submit(): void {
    const line = this.input.value;
    this.input.value = "";
    this.at = -1;
    if (!line.trim()) return;
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    } catch {
      /* private mode */
    }
    this.runner.run(line);
  }

  private recall(dir: -1 | 1): void {
    if (!this.history.length) return;
    if (this.at === -1) {
      if (dir === 1) return;
      this.draft = this.input.value;
      this.at = this.history.length - 1;
    } else this.at += dir;
    if (this.at >= this.history.length) {
      this.at = -1;
      this.input.value = this.draft;
    } else {
      this.at = Math.max(0, this.at);
      this.input.value = this.history[this.at];
    }
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  private tab(): void {
    const r = complete(this.input.value, this.maps);
    this.input.value = r.line;
    if (r.options.length) this.print(r.options.slice(0, 40).join("  ") + (r.options.length > 40 ? `  … ${r.options.length - 40} more` : ""), "dim");
  }
}
