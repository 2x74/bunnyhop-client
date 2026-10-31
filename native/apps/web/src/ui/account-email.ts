// "Save progress with email": enter an address, get a 6-digit code (and a link) by email, type the code here.
// The game stays open, so the code is the main path; the link (?signin=<token>) works in whichever browser opens it
// and is finished by handleAuthReturn() on page load. API: apps/api/src/email.ts.

import { appHref } from "../platform/navigation";
import { api, ApiError, type User } from "../api";
import { h } from "./dom";
import { confirmDialog } from "./settings-transfer";

export const OUTCOME: Record<string, string> = {
  linked: "Progress saved. Sign in with this email on any device.",
  merged: "Signed in. This browser's runs were added to your account.",
  signed_in: "Signed in.",
  created: "Signed in with a new account.",
};

const START_ERRORS: Record<string, string> = {
  bad_email: "That doesn't look like an email address.",
  rate_limited: "Too many codes. Try again in an hour.",
  email_busy: "Too many sign-in emails today. Try again tomorrow.",
  email_failed: "The email didn't send. Try again in a minute.",
  undeliverable: "That address can't receive email.",
  email_unavailable: "Email sign-in isn't set up yet.",
};

/** The two-step form. onDone receives the signed-in player and a one-line message. */
export function emailSignIn(o: { onDone: (u: User, message: string) => void; autofocus?: boolean }): HTMLElement {
  const root = h("div.email-signin");
  let address = "";

  const emailStep = (error = "") => {
    const input = h("input.es-input", { type: "email", autocomplete: "email", inputmode: "email", required: true, maxlength: "254", placeholder: "you@example.com", "aria-label": "Email", value: address });
    const msg = h("p.es-msg", { role: "alert", "data-kind": error ? "err" : "" }, error);
    const send = h("button.btn.primary", { type: "submit" }, "Send code");
    const form = h(
      "form.es-form",
      { novalidate: true },
      h("p.es-sub.dim", null, "We'll email you a 6-digit code to sign in."),
      h("div.es-row", null, input, send),
      msg,
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      address = input.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(address)) {
        msg.textContent = START_ERRORS.bad_email;
        msg.dataset.kind = "err";
        input.focus();
        return;
      }
      send.disabled = true;
      send.textContent = "Sending…";
      try {
        const r = await api.emailStart(address);
        codeStep(r.devCode ?? null);
      } catch (err) {
        send.disabled = false;
        send.textContent = "Send code";
        msg.textContent = err instanceof ApiError ? (START_ERRORS[err.code] ?? err.message) : "Couldn't reach the server. Try again.";
        msg.dataset.kind = "err";
      }
    });
    root.replaceChildren(form);
    if (o.autofocus !== false) requestAnimationFrame(() => input.focus());
  };

  const codeStep = (devCode: string | null) => {
    const input = h("input.es-code", {
      type: "text",
      inputmode: "numeric",
      autocomplete: "one-time-code",
      pattern: "[0-9 ]*",
      maxlength: "7",
      placeholder: "000000",
      "aria-label": "6-digit code",
    });
    const msg = h("p.es-msg", { role: "alert" });
    const go = h("button.btn.primary", { type: "submit" }, "Sign in");
    const form = h(
      "form.es-form",
      { novalidate: true },
      h("p.es-sub", null, "We sent a code to ", h("b", null, address), ". It works once, for 15 minutes."),
      h("div.es-row", null, input, go),
      msg,
      devCode ? h("p.es-dev", null, "Local dev: the email wasn't sent. Code ", h("code", null, devCode)) : null,
      h(
        "p.es-links",
        null,
        h("button.link-btn", { type: "button", onclick: () => emailStep() }, "Use another email"),
        h("button.link-btn", { type: "button", onclick: () => void resend() }, "Send a new code"),
      ),
    );
    const submit = async () => {
      const code = input.value.replace(/\D/g, "");
      if (code.length !== 6) return;
      go.disabled = true;
      try {
        const r = await api.emailVerify({ code });
        o.onDone(r.user, OUTCOME[r.outcome] ?? "Signed in.");
      } catch (err) {
        go.disabled = false;
        msg.dataset.kind = "err";
        msg.textContent = err instanceof ApiError ? err.message : "Couldn't reach the server. Try again.";
        if (err instanceof ApiError && err.code === "code_expired") input.disabled = true;
        else input.select();
      }
    };
    const resend = async () => {
      try {
        const r = await api.emailStart(address);
        codeStep(r.devCode ?? null);
      } catch (err) {
        msg.dataset.kind = "err";
        msg.textContent = err instanceof ApiError ? (START_ERRORS[err.code] ?? err.message) : "Couldn't reach the server. Try again.";
      }
    };
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^\d ]/g, "");
      msg.textContent = "";
      if (input.value.replace(/\D/g, "").length === 6) void submit();
    });
    form.addEventListener("submit", (e) => (e.preventDefault(), void submit()));
    root.replaceChildren(form);
    requestAnimationFrame(() => input.focus());
  };

  emailStep();
  return root;
}

const TOAST_KEY = "bunnyhop:toast";

/** Signed in as a different player: reload so boards, PBs and the profile all follow; the message survives the reload. */
export function reloadWithToast(message: string): void {
  try {
    sessionStorage.setItem(TOAST_KEY, message);
  } catch {
    /* private mode */
  }
  location.reload();
}

const LOGIN_ERROR: Record<string, string> = {
  discord_not_configured: "Discord sign-in isn't set up yet.",
};

/**
 * On page load: finish an email link (?signin=<token>) and report a Discord return (?login=discord / ?login_error=).
 * Strips the parameters from the URL. Returns a message for a toast, or null.
 */
export async function handleAuthReturn(): Promise<string | null> {
  const carried = sessionStorage.getItem(TOAST_KEY);
  if (carried) {
    sessionStorage.removeItem(TOAST_KEY);
    return carried;
  }
  const url = new URL(appHref());
  const token = url.searchParams.get("signin");
  const login = url.searchParams.get("login");
  const loginError = url.searchParams.get("login_error");
  if (!token && !login && !loginError) return null;
  for (const k of ["signin", "login", "login_error", "member"]) url.searchParams.delete(k);
  history.replaceState(null, "", url);
  if (loginError) return LOGIN_ERROR[loginError] ?? "Discord sign-in didn't finish. Try again.";
  // (Community server rewards from the sign-in are celebrated by the profile load: ui/unlocks.ts communityNote.)
  if (login === "discord") return "Signed in with Discord.";
  if (!token || !api.available()) return null;
  try {
    const r = await api.emailVerify({ token });
    return OUTCOME[r.outcome] ?? "Signed in.";
  } catch (e) {
    if (e instanceof ApiError && e.code === "confirm_switch") return confirmSwitch(token, e);
    return e instanceof ApiError ? e.message : "Couldn't reach the server to finish signing in.";
  }
}

/**
 * A sign-in link this browser didn't ask for, while it's on another player (someone may have sent their own link):
 * name the account and ask before switching. A guest left this way comes back on sign-out (the API keeps it).
 */
async function confirmSwitch(token: string, e: ApiError): Promise<string | null> {
  const email = typeof e.body.email === "string" ? e.body.email : "another account";
  const current = typeof e.body.current === "string" ? e.body.current : "this player";
  const guest = e.body.guest === true;
  const ok = await confirmDialog({
    title: "Switch account?",
    body:
      `This sign-in link is for ${email}, and it wasn't requested in this browser. Signing in leaves ${current}` +
      (guest ? " (signing out later brings this guest back)." : ".") +
      " Only continue if you asked for this email.",
    confirm: `Sign in as ${email}`,
  });
  if (!ok) return `Still playing as ${current}.`;
  try {
    const r = await api.emailVerify({ token, confirm: true });
    return OUTCOME[r.outcome] ?? "Signed in.";
  } catch (err) {
    return err instanceof ApiError ? err.message : "Couldn't reach the server to finish signing in.";
  }
}
