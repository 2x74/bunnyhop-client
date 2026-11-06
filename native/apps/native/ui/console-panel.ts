// The Source console runs the web's DOM-free parser and cvar table, with a compact native shell.
import { ConsoleRunner, complete, setConfigNames, type ConfigStore, type LineKind } from "../../web/src/console/exec";
import { mixesMoveAndTurn, MOVE_TURN_REFUSAL, runPress, runRelease } from "../../web/src/console/bind-run";
import { DEFAULT_PREFS, prefs, type Action } from "../../web/src/ui/settings";
import { h } from "../../web/src/ui/dom";
import { isTextField } from "../../web/src/input";
import { state, send } from "./bridge";
import { installPrefsBridge } from "./prefs-bridge";
import "./native-console.css";

export interface NativeConsoleHooks {
  action(action: Action, down?: boolean): boolean;
  chat(line: string, reply: (text: string) => void): boolean;
  map(name: string): string | null;
  maps(): Promise<string[]>;
  menu(): boolean;
  notice(text: string): void;
}

let view: NativeConsole | null = null;
let hooks: NativeConsoleHooks | null = null;
const CFG_PREFIX = "bunnyhop:cfg:";
const configs: ConfigStore = {
  list: () => {
    const names: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CFG_PREFIX)) names.push(key.slice(CFG_PREFIX.length));
      }
    } catch {
      /* storage blocked */
    }
    return names.sort();
  },
  get: (name) => {
    try {
      return localStorage.getItem(CFG_PREFIX + name);
    } catch {
      return null;
    }
  },
  set: (name, text) => {
    if (text.length > 32_000) return "That config is too big to save.";
    try {
      if (!configs.list().includes(name) && configs.list().length >= 20)
        return "There are 20 saved configs already; overwrite one.";
      localStorage.setItem(CFG_PREFIX + name, text);
      setConfigNames(configs.list());
      return null;
    } catch {
      return "This native client couldn't save the config.";
    }
  },
};

class NativeConsole {
  readonly dialog: HTMLDialogElement;
  private input: HTMLInputElement;
  private log: HTMLElement;
  private runner: ConsoleRunner;
  private history: string[] = [];
  private historyAt = -1;
  private draft = "";
  private maps: string[] = [];
  private openedInGame = false;
  private waitStages: Array<Array<() => void>> = [];

  constructor() {
    this.log = h("div.ncon-log", { role: "log", "aria-live": "polite" });
    this.input = h("input.ncon-input", {
      type: "text",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Console command",
      placeholder: "help · find · paste a config",
    }) as HTMLInputElement;
    this.dialog = h(
      "dialog.ncon",
      { "aria-label": "Console" },
      h(
        "header.ncon-head",
        null,
        h("div", null, h("h2", null, "Console")),
        h("button.ncon-close", { type: "button", "aria-label": "Close console", onclick: () => this.close() }, "×"),
      ),
      this.log,
      h(
        "form.ncon-line",
        { onsubmit: (e: Event) => (e.preventDefault(), this.submit()) },
        h("span.ncon-prompt", { "aria-hidden": "true" }, "]"),
        this.input,
        h("button.ncon-run", { type: "submit" }, "Run"),
      ),
      h("footer.ncon-foot", null, "↑/↓ history", h("span", null, "Tab complete"), h("span", null, "Esc close")),
    ) as HTMLDialogElement;
    this.runner = new ConsoleRunner({
      get: () => prefs.get(),
      update: (fn) => prefs.update(fn),
      print: (text, kind) => this.print(text, kind),
      clear: () => this.log.replaceChildren(),
      chat: (line, reply) => hooks?.chat(line, reply) ?? false,
      action: (a) => hooks?.action(a) ?? false,
      notice: (text) => hooks?.notice(text),
      retry: () => (state.map ? (send({ type: "mapLoad", action: "retry" }), true) : false),
      menu: () => hooks?.menu() ?? false,
      configs,
      openMap: (name) => hooks?.map(name) ?? "Maps open from the game.",
    });
    setConfigNames(configs.list());
    try {
      const saved = JSON.parse(localStorage.getItem("bunnyhop:native-console-history") ?? "[]");
      if (Array.isArray(saved)) this.history = saved.filter((v): v is string => typeof v === "string").slice(-50);
    } catch {
      /* empty history */
    }
    this.dialog.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") return void (event.preventDefault(), this.close());
      if (event.target !== this.input) return;
      if (event.key === "Tab") return void (event.preventDefault(), this.complete());
      if (event.key === "ArrowUp" || event.key === "ArrowDown")
        return void (event.preventDefault(), this.recall(event.key === "ArrowUp" ? -1 : 1));
    });
    this.input.addEventListener("paste", (event) => {
      const text = (event as ClipboardEvent).clipboardData?.getData("text") ?? "";
      if (!/[\r\n]/.test(text.trim())) return;
      event.preventDefault();
      this.print(`Pasted ${text.trim().split(/\r?\n/).length} lines.`, "dim");
      this.runner.paste(text);
    });
    this.dialog.addEventListener("close", () => {
      if (this.openedInGame) send({ type: "resume" });
      this.openedInGame = false;
    });
  }

  open(fromGame = !!state.map): void {
    this.openedInGame = fromGame && !!state.map;
    if (!this.dialog.isConnected) document.body.append(this.dialog);
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus({ preventScroll: true });
    if (!this.maps.length)
      void hooks
        ?.maps()
        .then((maps) => {
          this.maps = maps.map((m) => m.toLowerCase()).sort();
        })
        .catch(() => {});
    if (!this.log.childElementCount)
      this.print("Source syntax · shared web cvars and config format · type help", "dim");
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }
  owns(target: EventTarget | null): boolean {
    return target instanceof Node && this.dialog.contains(target);
  }

  private print(text: string, kind: LineKind = "out"): void {
    for (const line of text.split("\n")) this.log.append(h(`div.ncon-row.ncon-${kind}`, null, line));
    while (this.log.childElementCount > 400) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
  private submit(): void {
    const line = this.input.value;
    this.input.value = "";
    this.historyAt = -1;
    if (!line.trim()) return;
    if (this.history.at(-1) !== line) this.history.push(line);
    if (this.history.length > 50) this.history.shift();
    try {
      localStorage.setItem("bunnyhop:native-console-history", JSON.stringify(this.history));
    } catch {
      /* private storage */
    }
    this.runner.run(line);
  }
  private recall(direction: -1 | 1): void {
    if (!this.history.length) return;
    if (this.historyAt < 0) {
      if (direction > 0) return;
      this.draft = this.input.value;
      this.historyAt = this.history.length - 1;
    } else this.historyAt += direction;
    if (this.historyAt >= this.history.length) {
      this.historyAt = -1;
      this.input.value = this.draft;
    } else {
      this.historyAt = Math.max(0, this.historyAt);
      this.input.value = this.history[this.historyAt] ?? "";
    }
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }
  private complete(): void {
    const result = complete(this.input.value, this.maps);
    this.input.value = result.line;
    if (result.options.length === 1) this.print(result.options[0], "dim");
    else if (result.options.length > 1) this.print(result.options.join("   "), "dim");
  }

  dispatchBind(detail: { code: string; down: boolean; command: string }): void {
    if (!detail.command || !detail.code) return;
    if (detail.down && mixesMoveAndTurn(detail.command, prefs.get().aliases ?? {})) {
      this.print(MOVE_TURN_REFUSAL, "err");
      hooks?.notice(MOVE_TURN_REFUSAL);
      return;
    }
    let stage = 0;
    let usedWait = false;
    const later = (fn: () => void) => {
      if (stage > 0) (this.waitStages[stage - 1] ??= []).push(fn);
      else fn();
    };
    const ops = {
      hold: (action: Action) => later(() => hooks?.action(action, true)),
      unhold: (action: Action) => later(() => hooks?.action(action, false)),
      once: (command: string) => later(() => this.runner.runBound(command)),
      error: (text: string) => {
        this.print(text, "err");
        hooks?.notice(text);
      },
      wait: () => {
        usedWait = true;
        stage++;
      },
    };
    if (detail.down) runPress(detail.command, prefs.get().aliases ?? {}, ops);
    else runRelease(detail.command, prefs.get().aliases ?? {}, ops);
    if (usedWait && this.waitStages.length < stage) this.waitStages.length = stage;
    this.scheduleWaitTick();
  }

  private scheduleWaitTick(): void {
    if (this.waitStages.length) send({ type: "consoleWait" });
  }

  advanceWaitTick(): void {
    const stage = this.waitStages.shift();
    for (const run of stage ?? []) run();
    this.scheduleWaitTick();
  }
}

export function installNativeConsole(h: NativeConsoleHooks): void {
  hooks = h;
  installPrefsBridge();
  view ??= new NativeConsole();
  window.addEventListener("bunnyhop:native-console-open", (event) => {
    const fromGame = (event as CustomEvent<{ fromGame?: boolean }>).detail?.fromGame ?? !!state.map;
    view?.open(fromGame);
  });
  // The console key also works on menu screens where the SDL game input path is not active.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if (view?.owns(event.target) || isTextField(event.target)) return;
      const codes = (prefs.get().binds.console ?? []) as string[];
      if (!codes.includes(event.code)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      view?.open(false);
    },
    true,
  );
  window.addEventListener("bunnyhop:native-console-bind", (event) => view?.dispatchBind((event as CustomEvent).detail));
  window.addEventListener("bunnyhop:native-console-tick", () => view?.advanceWaitTick());
  // Ensure an old config with no binds gets the same Source console default as the web.
  if (!prefs.get().binds.console)
    prefs.update((p) => {
      p.binds.console = [...(DEFAULT_PREFS.binds.console ?? ["Backquote"])];
    });
}
