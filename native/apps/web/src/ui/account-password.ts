// Name + password sign-in (API: apps/api/src/password.ts). The display name is the login. Real <form>s with autocomplete
// tokens, so browser password managers fill and save them: they submit through the API, then leave the page, which is the
// signal managers wait for. A login may ask for a security check first (ui/turnstile.ts). Styles: ui/account.css (.es-*,
// shared with the email form).

import { WAVEDASH } from "../platform/env";
import { api, ApiError, type AccountView, type User } from "../api";
import { OUTCOME } from "./account-email";
import { h } from "./dom";
import { mountTurnstile, type TurnstileWidget } from "./turnstile";

/** apps/api src/password.ts PASSWORD_MAX. The server has the real rules. */
const PASSWORD_MAX = "256";
export const NO_RESET = "With no email or Discord on the account, a lost password can't be reset.";
const NO_CHECK = `The security check can't load here. Sign in with ${WAVEDASH ? "email" : "email or Discord"}, or from a browser you've signed in on.`;
const RESET_KEY = "bunnyhop:password-reset";

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");

function setMsg(msg: HTMLElement, text: string, kind: "err" | "" = "err"): void {
  msg.textContent = text;
  msg.dataset.kind = kind;
}

/** The player is on their way to a reset: after the Discord or email sign-in, the account panel opens at the password. */
export function markPasswordReset(): void {
  try {
    sessionStorage.setItem(RESET_KEY, "1");
  } catch {
    /* private mode: they can open Account themselves */
  }
}

export function takePasswordReset(): boolean {
  try {
    const on = !!sessionStorage.getItem(RESET_KEY);
    if (on) sessionStorage.removeItem(RESET_KEY);
    return on;
  } catch {
    return false;
  }
}

/** Name (or email) and password. onForgot: shows the way to reset, under the form. */
export function passwordSignIn(o: { onDone: (u: User, message: string) => void; onForgot: () => void; autofocus?: boolean }): HTMLElement {
  const login = h("input.es-input", { type: "text", name: "username", autocomplete: "username", autocapitalize: "off", spellcheck: "false", maxlength: "254", placeholder: "Name or email", "aria-label": "Name or email" });
  const password = h("input.es-input", { type: "password", name: "password", autocomplete: "current-password", maxlength: PASSWORD_MAX, placeholder: "Password", "aria-label": "Password" });
  const msg = h("p.es-msg", { role: "alert" });
  const go = h("button.btn.primary", { type: "submit" }, "Sign in");
  const forgot = h("button.link-btn", { type: "button", onclick: () => o.onForgot() }, "Forgot password?");
  const check = h("div.pw-check", { hidden: true });
  const form = h("form.es-form", { novalidate: true }, login, password, check, h("div.es-row.pw-actions", null, go, forgot), msg);
  // The security check, when the server asks for one (apps/api src/password.ts). A token works once, so a wrong password
  // needs a fresh one, but only the server's request for a check resubmits by itself: a wrong password is never retried.
  let token: string | undefined;
  let submitOnToken = false;
  let refused = 0;
  let widget: TurnstileWidget | null = null;
  const noCheck = () => {
    check.hidden = true;
    submitOnToken = false;
    setMsg(msg, NO_CHECK);
  };
  const askForCheck = async (siteKey: string, hadToken: boolean) => {
    // A passed check the server keeps refusing won't get better by repeating it.
    if (hadToken && ++refused >= 2) return noCheck();
    submitOnToken = true;
    if (widget) return widget.reset();
    check.hidden = false;
    widget = await mountTurnstile(
      check,
      siteKey,
      (t) => {
        token = t;
        if (!submitOnToken) return;
        submitOnToken = false;
        setMsg(msg, "", "");
        form.requestSubmit();
      },
      noCheck,
    );
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!login.value.trim() || !password.value) return void (login.value.trim() ? password : login).focus();
    go.disabled = true;
    const sent = token;
    token = undefined;
    try {
      const r = await api.passwordLogin(login.value.trim(), password.value, sent);
      widget?.remove();
      form.remove();
      o.onDone(r.user, r.aliasUsed ? `${OUTCOME[r.outcome] ?? "Signed in."} Your name is now ${r.user.name}.` : (OUTCOME[r.outcome] ?? "Signed in."));
    } catch (err) {
      go.disabled = false;
      setMsg(msg, errorText(err));
      if (err instanceof ApiError && err.code === "turnstile_required" && typeof err.body.siteKey === "string") void askForCheck(err.body.siteKey, !!sent);
      else {
        if (sent) widget?.reset();
        password.select();
      }
    }
  });
  if (o.autofocus !== false) requestAnimationFrame(() => login.focus());
  return form;
}

/**
 * Setting a password. `view` says which of the three: first time, change (current password), or reset (the recovery
 * window). The hidden username is the login the password manager saves it under.
 */
export function passwordForm(o: { user: User; view: AccountView; onDone: (v: AccountView) => void; onForgot?: () => void; autofocus?: boolean; aside?: HTMLElement }): HTMLElement {
  const { user, view } = o;
  const needsCurrent = view.password.set && !view.password.resetUntil;
  const hasReset = view.methods.some((m) => m.provider === "email" || m.provider === "discord");
  const email = view.methods.find((m) => m.provider === "email")?.label;
  const username = h("input", { type: "text", name: "username", autocomplete: "username", value: view.name.isDefault && email ? email : user.name, hidden: true, readonly: true, tabindex: "-1", "aria-hidden": "true" });
  const current = needsCurrent ? h("input.es-input", { type: "password", name: "current-password", autocomplete: "current-password", maxlength: PASSWORD_MAX, placeholder: "Current password", "aria-label": "Current password" }) : null;
  const next = h("input.es-input", { type: "password", name: "new-password", autocomplete: "new-password", maxlength: PASSWORD_MAX, placeholder: view.password.set ? "New password, 8 characters or more" : "Password, 8 characters or more", "aria-label": view.password.set ? "New password" : "Password" });
  const msg = h("p.es-msg", { role: "alert" });
  const go = h("button.btn.primary", { type: "submit" }, "Save password");
  const until = view.password.resetUntil ? new Date(view.password.resetUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
  const note = until
    ? `You can set a new password without the old one until ${until}. This signs out your other devices.`
    : view.password.set
      ? "Changing it signs out your other devices."
      : view.name.isDefault
        ? `You'll sign in with ${email ?? "your email"} and this password.${hasReset ? "" : ` ${NO_RESET}`}`
        : `You'll sign in with the name ${user.name} and this password.${hasReset ? "" : ` ${NO_RESET}`}`;
  const form = h(
    "form.es-form",
    { novalidate: true },
    username,
    current,
    next,
    h("p.es-sub.dim", null, note),
    h("div.es-row.pw-actions", null, go, needsCurrent && o.onForgot ? h("button.link-btn", { type: "button", onclick: () => o.onForgot!() }, "Forgot password?") : null, o.aside),
    msg,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (current && !current.value) return void current.focus();
    if (!next.value) return void next.focus();
    go.disabled = true;
    try {
      const v = await api.setPassword(next.value, current?.value);
      form.remove();
      o.onDone(v);
    } catch (err) {
      go.disabled = false;
      setMsg(msg, errorText(err));
      if (err instanceof ApiError && err.code === "wrong_password") current?.select();
      else next.select();
    }
  });
  if (o.autofocus !== false) requestAnimationFrame(() => (current ?? next).focus());
  return form;
}
