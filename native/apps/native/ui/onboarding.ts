import { h } from "../../web/src/ui/dom";
import { api, type User } from "../../web/src/api";
import { accountChanged } from "../../web/src/ui/account-state";
import { SECOND_ACCOUNT_HELP } from "../../web/src/ui/account-copy";
import { emailSignIn } from "../../web/src/ui/account-email";
import { nameField } from "../../web/src/ui/account-name";
import { markPasswordReset, passwordSignIn } from "../../web/src/ui/account-password";
import { localName } from "../../web/src/ui/account";
import { COSMETICS } from "../../web/src/progression";
import { getOutfit, setOutfit } from "../../web/src/player/cosmetics";
import { firstMapOfTheDay } from "../../web/src/ui/first-map";
import { bunnyStage, type BunnyStage } from "./onboarding-preview";
import { toast } from "./account-panel";
import { LIVE_ORIGIN, openAuth, send, state } from "./bridge";
const DONE = "bunnyhop:onboarded";
export function hasOnboardingHistory(storage: Storage): boolean {
  if (storage.getItem(DONE) || storage.getItem("bunnyhop:last-map") || storage.getItem("bunnyhop:stats")) return true;
  for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith("bunnyhop:pb:")) return true;
  return false;
}
export const convertSensitivity = (s: number, yaw: number) => Math.round(((s * yaw) / 0.022) * 1000) / 1000;
interface Hooks {
  play: (map: string) => void;
  learn: () => void;
  active: () => boolean;
}
let running = false;
export async function maybeStartOnboarding(hooks: Hooks): Promise<void> {
  try {
    if (hasOnboardingHistory(localStorage)) return;
  } catch {
    /* private storage */
  }
  const user = await api.me().catch(() => null);
  if (user?.onboarded || !hooks.active()) return;
  openOnboarding(hooks);
}
export function openOnboarding(hooks: Hooks): void {
  if (running) return;
  running = true;
  const previous = document.activeElement as HTMLElement | null;
  const dialog = h("dialog.native-intro", { "aria-label": "Welcome to bunnyhop.lol" }) as HTMLDialogElement;
  const body = h("div"),
    close = h("button.btn", { type: "button", onclick: () => finish() }, "Skip intro");
  let step = 0;
  let stage: BunnyStage | null = null;
  const finish = (action?: () => void, launch = false) => {
    try {
      localStorage.setItem(DONE, String(Date.now()));
    } catch {
      /* private storage */
    }
    const done = () => {
      if (!dialog.open) return;
      dialog.close();
      action?.();
    };
    if (launch && stage) void stage.launch().then(done);
    else done();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener("close", () => {
    running = false;
    stage?.dispose();
    dialog.remove();
    previous?.isConnected && previous.focus();
  });
  const host = h("div.native-intro-stage"),
    layout = h("div.native-intro-layout", null, host, body);
  dialog.append(layout, close);
  document.body.append(dialog);
  dialog.showModal();
  stage = bunnyStage(host);
  if (!stage) {
    host.remove();
    layout.style.gridTemplateColumns = "1fr";
  }
  stage?.setName(localName() === "player" ? "" : localName());
  stage?.strafe(true);
  const next = () => {
    if (step === 0) stage?.fly();
    stage?.pivot(1);
    step++;
    paint();
  };
  // A returning player leaves the intro as themself. A new account carries on from the name.
  const signedIn = (user: User, message: string) => {
    accountChanged(user);
    toast(message);
    if (user.onboarded) {
      finish();
      return;
    }
    stage?.setName(user.name);
    next();
  };
  async function paintSignIn(): Promise<void> {
    const back = h("button.btn", { type: "button", onclick: () => paint() }, "Back");
    const providers = await api.providers().catch(() => ({ discord: false, email: false }));
    if (!dialog.open) return;
    const forgot = h(
      "p.acct-note",
      { hidden: true },
      "Sign in below with the Discord or email on your account, then you have 15 minutes to set a new password without the old one. An account with neither can't be reset.",
    );
    const discord = h(
      "button.btn.discord",
      {
        type: "button",
        onclick: () => finish(() => openAuth(api.discordLoginUrl(`${LIVE_ORIGIN}/?native=1`))),
      },
      "Sign in with Discord",
    );
    // Name and password first: it can't make a second account, a Discord or email that's new here can.
    const methods = [
      passwordSignIn({
        onDone: signedIn,
        onForgot: () => {
          markPasswordReset();
          forgot.hidden = false;
        },
      }),
      forgot,
      providers.discord ? discord : null,
      providers.email ? emailSignIn({ autofocus: false, onDone: signedIn }) : null,
      providers.discord || providers.email ? h("p.acct-note.dim", null, SECOND_ACCOUNT_HELP) : null,
    ].filter((method): method is HTMLElement => !!method);
    body.replaceChildren(
      h("h2", null, "Sign in"),
      h("div.native-intro-signin", null, ...methods),
      h("div.native-intro-actions", null, back),
    );
  }
  function paint(): void {
    stage?.strafe(step === 0);
    const actions = h("div.native-intro-actions");
    if (step > 0)
      actions.append(
        h(
          "button.btn",
          {
            type: "button",
            onclick: () => {
              step--;
              stage?.pivot(-1);
              paint();
            },
          },
          "Back",
        ),
      );
    if (step === 0) {
      const nf = nameField({
        initial: localName() === "player" ? "" : localName(),
        onSaved: (user) => accountChanged(user ?? undefined),
      });
      nf.input.setAttribute("aria-label", "Display name");
      nf.input.addEventListener("input", () => {
        stage?.typed();
        stage?.setName(nf.input.value);
        stage?.puzzled(!nf.valid() && !!nf.input.value);
      });
      const btn = h(
        "button.btn.primary",
        {
          type: "button",
          onclick: async () => {
            btn.disabled = true;
            const saved = await nf.save();
            if (saved && dialog.open) {
              stage?.puzzled(false);
              next();
            } else {
              stage?.puzzled(true);
              btn.disabled = false;
            }
          },
        },
        "Next",
      );
      nf.input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          btn.click();
        }
      });
      actions.append(
        btn,
        h("button.link-btn", { type: "button", onclick: () => void paintSignIn() }, "Already play? Sign in"),
      );
      body.replaceChildren(h("h2", null, "What should we call you?"), nf.el, actions);
    } else if (step === 1) {
      const grid = h("div.native-intro-colours", { role: "group", "aria-label": "Outfit colour" });
      for (const item of COSMETICS.filter((c) => c.slot === "outfit" && c.unlock.kind === "free")) {
        const button = h(
          "button.btn",
          {
            type: "button",
            "aria-pressed": String(getOutfit() === item.id),
            onclick: () => {
              setOutfit(item.id);
              stage?.setColor(item.color ?? "#efe9dd");
              stage?.show(item.id);
              if (api.available()) void api.saveCosmetics({ outfit: item.id }).catch(() => undefined);
              paint();
            },
          },
          item.name,
        );
        button.style.borderColor = item.color ?? "";
        grid.append(button);
      }
      actions.append(h("button.btn.primary", { type: "button", onclick: next }, "Next"));
      body.replaceChildren(h("h2", null, "Pick a colour."), grid, actions);
    } else if (step === 2) {
      const game = h(
        "select",
        { "aria-label": "Game" },
        h("option", { value: ".022" }, "CS2 / Source / Quake"),
        h("option", { value: ".07" }, "Valorant"),
        h("option", { value: ".0066" }, "Overwatch 2"),
      );
      const sensitivity = h("input", {
        type: "number",
        min: "0.01",
        max: "100",
        step: "0.01",
        value: String(state.settings.sensitivity),
        "aria-label": "Your sensitivity",
      });
      const result = h("p", { "aria-live": "polite" });
      const apply = () => {
        const value = convertSensitivity(Number(sensitivity.value), Number(game.value));
        if (!Number.isFinite(value) || value < 0.01 || value > 100) {
          result.textContent = "Enter a sensitivity between 0.01 and 100 in CS:S units.";
          return false;
        }
        send({ type: "settings", patch: { sensitivity: value } });
        result.textContent = `${value} in CS:S units`;
        stage?.spin(((360 / (value * 0.022)) * 2.54) / 800);
        return true;
      };
      for (const el of [game, sensitivity]) el.addEventListener("input", apply);
      actions.append(
        h(
          "button.btn.primary",
          {
            type: "button",
            onclick: () => {
              if (apply()) next();
            },
          },
          "Next",
        ),
      );
      body.replaceChildren(h("h2", null, "Match your mouse sensitivity."), game, sensitivity, result, actions);
    } else {
      actions.append(
        h(
          "button.btn.primary",
          { type: "button", onclick: () => finish(() => hooks.play(firstMapOfTheDay()), true) },
          "Yes, hop in",
        ),
        h("button.btn", { type: "button", onclick: () => finish(hooks.learn) }, "No, teach me"),
      );
      body.replaceChildren(
        h("h2", null, "Have you bhopped before?"),
        h("p.dim", null, "You can revisit the tutorial and change your look or sensitivity from the menu."),
        actions,
      );
    }
    body.querySelector<HTMLElement>("input,button,select")?.focus();
  }
  paint();
}
