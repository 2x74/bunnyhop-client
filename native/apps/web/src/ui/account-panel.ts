import { appHref } from "../platform/navigation";
import { SECOND_ACCOUNT_HELP } from "./account-copy";
// Account panel (a modal sheet opened from the account chip, the pause menu or onboarding). Its top is your name plate:
// the name as players see it (avatar, flag, colour, marks), edited in place (Enter or leaving the field saves it, with
// the name field's live checks). Then sign-in methods (password, Discord, email) with link / unlink, the Discord avatar
// toggle, your supporter thank-you, and a quiet footer: replay the intro, sign out. Anything you can't take back (unlink,
// sign out, start over) is a hold-to-confirm button (ui/hold.ts), not a confirm() box.
// Styles: ui/account.css (design tokens from style.css).

import { api, ApiError, type AccountView, type MySupport, type User } from "../api";
import { accountAvatar as avatarEl, accountChanged, getReplayIntro, me, myProfile } from "./account-state";
import { emailSignIn, reloadWithToast } from "./account-email";
import { nameField, NAME_LOCAL_KEY } from "./account-name";
import { markPasswordReset, NO_RESET, passwordForm, passwordSignIn, takePasswordReset } from "./account-password";
import { h } from "./dom";
import { cleanName, isDefaultName } from "../moderation/names";
import { holdButton } from "./hold";
import { nameAttrs, nameMarks } from "./marks";
import { countryFlag } from "./country-flag";
import { getOutfit } from "../player/cosmetics";
import { COSMETICS } from "../progression";
import "./account.css";
import { toast as notifyToast } from "../notify";
import { dismissOutside } from "./dismiss";
import { WAVEDASH } from "../platform/env";
import { platformSections } from "./account-platform";

export type AccountSection = "name" | "save" | "password" | "support" | null;

let open: HTMLDialogElement | null = null;

/** A modal dialog that keeps keys away from the menu / game handlers underneath. */
export function modal(cls: string, label: string, onClose?: () => void): HTMLDialogElement {
  const d = h("dialog", { class: cls, "aria-label": label }) as HTMLDialogElement;
  d.addEventListener("keydown", (e) => e.stopPropagation());
  // A press outside the dialog closes it (ui/dismiss.ts: starts and ends outside, top dialog only).
  dismissOutside(d, () => d.close());
  d.addEventListener("close", () => {
    d.remove();
    onClose?.();
  });
  document.body.append(d);
  return d;
}

/** A toast (notify/; shown above an open dialog's backdrop too). */
export function toast(msg: string, ms?: number): void {
  notifyToast(msg, { ms });
}

const DISCORD_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" width="1.15em" height="1.15em"><path fill="currentColor" d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18a19.7 19.7 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4-2 1 1.3 2a19.6 19.6 0 0 0 6-3c.5-5.1-.8-9.6-3.6-13.6ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg>`;
const MAIL_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" width="1.15em" height="1.15em"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
const KEY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" width="1.15em" height="1.15em"><circle cx="8" cy="15" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m11.5 11.5 8-8M16 7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

/** Opens the panel (one at a time). `section` scrolls to / opens a part of it. */
export function openAccountPanel(section: AccountSection = null): void {
  if (open) open.close();
  const d = modal("acct-dialog", "Account", () => (open = null));
  open = d;
  const body = h("div.acct-body", null, h("p.dim", null, "Loading…"));
  d.append(
    h("header.acct-head", null, h("h2", null, "Account"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, "×")),
    body,
  );
  d.showModal();
  void render(d, body, section);
}

async function render(d: HTMLDialogElement, body: HTMLElement, section: AccountSection): Promise<void> {
  const online = api.available();
  const user = await me();
  let view: AccountView | null = null;
  let providers = { discord: false, email: false };
  // Sign-in methods come from /auth/providers alone (Discord: true once DISCORD_CLIENT_ID / _SECRET are set), so
  // "Link Discord" shows even before this browser has a player.
  let support: MySupport | null = null;
  if (online) {
    [view, providers, support] = await Promise.all([user ? api.account().catch(() => null) : null, api.providers().catch(() => providers), user ? api.mySupport().catch(() => null) : null]);
  }
  if (!d.open) return;
  const u: User = view?.user ?? user ?? { id: "", name: localStorage.getItem(NAME_LOCAL_KEY) || "player", avatarUrl: null, provider: "guest" };
  const guest = u.provider === "guest";
  const methods = view?.methods ?? [];
  const has = (p: string) => methods.find((m) => m.provider === p) ?? null;

  // --- your name plate: the in-game name tag (dot in your colourway, name, marks), the name editable in place
  const methodName = (p: string) => (p === "email" ? "email" : p === "wavedash" ? "Wavedash" : p === "password" ? "a password" : "Discord");
  const status = !online ? "Offline: your name stays in this browser." : guest ? "Guest: your runs live in this browser." : `Signed in with ${methods.map((m) => methodName(m.provider)).join(" and ") || u.provider}`;
  const left = view?.name;
  let current = u.name;
  const nf = nameField({
    initial: isDefaultName(u.name) ? "" : u.name,
    onSaved: (nu, name) => {
      current = name;
      accountChanged(nu ?? undefined);
      void rerender();
    },
  });
  nf.input.setAttribute("aria-label", "Display name");
  if (isDefaultName(u.name)) nf.input.placeholder = "Pick a name";
  const commit = () => {
    const v = cleanName(nf.input.value);
    if (!v || v === current) return;
    void nf.save();
  };
  nf.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (e.preventDefault(), commit());
  });
  // Leaving the field saves it (unless it's for the dice, which fills it in).
  nf.input.addEventListener("blur", (e) => !(e.relatedTarget as Element | null)?.closest?.(".nf-dice") && commit());
  const dot = h("i.acct-plate-dot", { style: `--dot:${COSMETICS.find((c) => c.id === getOutfit())?.color ?? "#efe9dd"}`, "aria-hidden": "true" });
  const flagSlot = h("span.acct-plate-flag");
  const marksSlot = h("span.acct-plate-marks");
  // The field's input and dice ride in the plate; its message line goes under it.
  const plate = h("div.acct-plate", null, dot, flagSlot, nf.el.querySelector(".nf-row")!, marksSlot);
  const nameMsg = nf.el.querySelector(".nf-msg")!;
  if (online && user && !guest) {
    void myProfile().then((pr) => {
      if (!pr?.mine || !plate.isConnected) return;
      const look = nameAttrs(pr.player);
      if (look.style) nf.input.setAttribute("style", look.style);
      const flag = countryFlag(pr.player.country);
      if (flag) flagSlot.replaceChildren(flag);
      const m = nameMarks(pr.player);
      if (m) marksSlot.replaceChildren(m);
    });
  }
  const who = h(
    "section.acct-who",
    { id: "acct-name" },
    avatarEl(u, 48),
    h(
      "div.acct-who-main",
      null,
      plate,
      nameMsg,
      h("small.acct-who-status", null, status, left && !left.isDefault ? ` ${left.changesLeft > 0 ? `${left.changesLeft} of ${left.limit} name changes left today.` : "No name changes left today."}` : ""),
      // The name is the login (apps/api src/password.ts), and the old one stops working as soon as it changes.
      view?.password.set && !left?.isDefault ? h("small.acct-who-status", null, "You sign in with this name. If you change it, sign in with the new one: the old one stops working.") : null,
      // After a staff rename the old name still works, until this player picks a name themself (apps/api src/names.ts).
      view?.password.alias ? h("small.acct-who-status", null, "Staff changed your name. Your old name still signs you in until you pick a new name yourself.") : null,
      // The avatar editor is its own page (avatar.html); the Wavedash build opens it on the site.
      h("a.acct-av-edit", WAVEDASH ? { href: "https://bunnyhop.lol/avatar", target: "_blank", rel: "noopener" } : { href: "/avatar" }, "Edit avatar"),
    ),
  );
  const nameSec = who;

  // A sign-in from this panel: another player reloads the page; the same one (a reset) stays here.
  const finishSignIn = (nu: User, message: string) => {
    if (nu.id !== u.id) return reloadWithToast(message);
    toast(message);
    accountChanged(nu);
    void rerender(takePasswordReset() ? "password" : null);
  };

  // --- the password row (apps/api src/password.ts): set, change, or reset in the window a fresh sign-in opens
  const forgotPassword = (box: HTMLElement) => {
    const discord = has("discord") && providers.discord && !WAVEDASH ? h("a.btn.discord", { href: api.discordLoginUrl(appHref()), html: `${DISCORD_SVG}<span>Sign in with Discord</span>` }) : null;
    const email = has("email") && providers.email ? emailSignIn({ autofocus: false, onDone: finishSignIn }) : null;
    markPasswordReset();
    box.replaceChildren(
      h("p.acct-note", null, discord || email ? "Sign in with the Discord or email on this account, then you have 15 minutes to set a new password without the old one." : NO_RESET),
      ...(discord ? [discord] : []),
      ...(email ? [email] : []),
    );
  };
  const passwordRow = () => {
    if (!view) return null;
    const v = view;
    const needsName = !v.password.set && v.name.isDefault && !has("email");
    const box = h("div.email-signin");
    const open = () => {
      action.remove();
      box.append(
        passwordForm({
          user: u,
          view: v,
          onForgot: () => forgotPassword(box),
          onDone: (nv) => {
            accountChanged(nv.user);
            toast(v.password.set ? "Password changed. Your other devices are signed out." : "Password saved. Sign in with it on any device.");
            void rerender();
          },
        }),
      );
      if (!v.password.set) return;
      const can = v.canUnlink.password ?? false;
      const remove: HTMLButtonElement = holdButton(
        "Remove password",
        async () => {
          remove.disabled = true;
          try {
            accountChanged((await api.unlink("password", box.querySelector<HTMLInputElement>('input[name="current-password"]')?.value)).user);
            toast("Password removed.");
            void rerender();
          } catch (err) {
            remove.disabled = false;
            toast(err instanceof ApiError ? err.message : "Couldn't reach the server.");
          }
        },
        { className: "acct-unlink btn-sm btn-ghost", disabled: !can, title: can ? "Hold to remove your password. Type your current one above first." : "Add another way to sign in first. This is the only way back into your account." },
      );
      box.append(remove);
    };
    const action = needsName
      ? h("button.btn", { type: "button", onclick: () => nf.input.focus() }, "Pick a name")
      : h("button.btn", { type: "button", onclick: open }, v.password.resetUntil ? "Set a new one" : v.password.set ? "Change" : "Set password");
    const line = v.password.set ? (v.name.isDefault ? (v.password.alias ? "Sign in with your old name" : "Sign in with your email") : `Sign in as ${u.name}`) : needsName ? "Pick a name first: it's what you sign in with" : "Not set";
    const row = h("div.acct-method", null, h("span.acct-icon.password", { html: KEY_SVG }), h("div.acct-minfo", null, h("b", null, "Password"), h("small.dim", null, line)), action);
    return { row, box, open };
  };

  // --- sign-in methods
  const methodRow = (p: "discord" | "email" | "wavedash") => {
    const m = has(p);
    const label = p === "discord" ? "Discord" : p === "wavedash" ? "Wavedash" : "Email";
    const icon = p === "wavedash" ? h("span.acct-icon.wavedash", { "aria-hidden": "true" }, "W") : h(`span.acct-icon.${p}`, { html: p === "discord" ? DISCORD_SVG : MAIL_SVG });
    const info = h("div.acct-minfo", null, h("b", null, label), h("small.dim", null, m ? (p === "discord" ? `@${m.label}` : m.label) : "Not linked"));
    let action: HTMLElement | null = null;
    if (m) {
      const can = view?.canUnlink[p] ?? false;
      // Unlinking the last way to reset a password leaves the password as the only way in.
      const lastReset = p !== "wavedash" && has("password") && !methods.some((x) => x.provider !== p && x.provider !== "password");
      const unlink: HTMLButtonElement = holdButton(
        "Unlink",
        async () => {
          unlink.disabled = true;
          try {
            const v = await api.unlink(p);
            accountChanged(v.user);
            toast(`${label} unlinked.`);
            void rerender();
          } catch (err) {
            unlink.disabled = false;
            toast(err instanceof ApiError ? err.message : "Couldn't reach the server.");
          }
        },
        { className: "acct-unlink", disabled: !can, title: can ? `Hold to unlink ${label}: you won't be able to sign in with it any more.${lastReset ? ` ${NO_RESET}` : ""}` : "Add another way to sign in first. This is the only way back into your account." },
      );
      action = unlink;
    } else if (p === "discord" && providers.discord && !WAVEDASH) {
      // (The Wavedash build can't show Discord's sign-in page in its frame: email sign-in brings an account there.)
      action = h("a.btn.discord", { href: api.discordLoginUrl(appHref()), html: `${DISCORD_SVG}<span>${guest ? "Sign in with Discord" : "Link Discord"}</span>` });
    } else if (p === "email" && providers.email) {
      action = h(
        "button.btn",
        {
          type: "button",
          onclick: (e: Event) => {
            const row = (e.currentTarget as HTMLElement).closest(".acct-method")!;
            (e.currentTarget as HTMLElement).remove();
            row.after(
              emailSignIn({ onDone: finishSignIn }),
            );
          },
        },
        // A Wavedash player's email sign-in is how an account from the site comes along (ui/account-platform.ts).
        guest || (WAVEDASH && u.provider === "wavedash") ? "Sign in with email" : "Add email",
      );
    }
    if (!m && !action) return null;
    return h("div.acct-method", null, icon, info, action);
  };
  const pw = online ? passwordRow() : null;
  const discordRow = online ? methodRow("discord") : null;
  const emailRow = online ? methodRow("email") : null;
  const wavedashRow = online && has("wavedash") ? methodRow("wavedash") : null;
  // Discord avatar, opt-in (off by default, instant and reversible): right under the Discord row it comes from. Shows
  // the picture it would use; staff can block it (then the switch is off and locked).
  const blocked = u.discordAvatarBlocked === true;
  const avatarToggle =
    has("discord") && u.discordAvatarUrl !== undefined
      ? h(
          "label.acct-toggle.acct-avatar",
          null,
          h("input.switch", {
            type: "checkbox",
            checked: u.useDiscordAvatar === true && !blocked,
            disabled: blocked,
            onchange: async (e: Event) => {
              const box = e.currentTarget as HTMLInputElement;
              box.disabled = true;
              try {
                accountChanged(await api.setUseDiscordAvatar(box.checked));
                void rerender();
              } catch (err) {
                box.checked = !box.checked;
                box.disabled = false;
                toast(err instanceof ApiError ? err.message : "Couldn't reach the server.");
              }
            },
          }),
          u.discordAvatarUrl && !blocked ? avatarEl({ name: u.name, avatarUrl: u.discordAvatarUrl }, 28) : null,
          h(
            "span.acct-minfo",
            null,
            h("b", null, "Use my Discord avatar"),
            h(
              "small.dim",
              null,
              blocked
                ? "A moderator removed your Discord avatar, so it can't be turned on."
                : !u.discordAvatarUrl
                  ? "Your Discord account has no picture of its own, so your bunny shows."
                  : "Instead of your bunny, on your profile and the leaderboards.",
            ),
          ),
        )
      : null;
  // A returning player on a fresh guest: name and password. (Discord and email sign in from their rows above.)
  const signInBox = h("div.email-signin");
  const openSignIn = () => {
    signInBtn.remove();
    signInBox.replaceChildren(
      passwordSignIn({
        onDone: finishSignIn,
        onForgot: () => {
          markPasswordReset();
          signInBox.append(h("p.acct-note", null, `Sign in above with the Discord or email on your account, then you have 15 minutes to set a new password without the old one. ${NO_RESET}`));
        },
      }),
    );
  };
  const signInBtn = h("button.link-btn.acct-signin", { type: "button", onclick: openSignIn }, "Already have an account? Sign in");
  const canSignIn = online && (guest || (WAVEDASH && u.provider === "wavedash"));
  const saveSec =
    online && (pw || discordRow || emailRow || wavedashRow || canSignIn)
      ? h(
          "section.acct-sec",
          { id: "acct-save" },
          h("h3", null, guest ? "Save progress" : "Sign-in methods"),
          guest ? h("p.acct-note", null, "Guest progress lives in this browser until you save it.") : null,
          pw?.row,
          pw?.box,
          wavedashRow,
          discordRow,
          avatarToggle,
          emailRow,
          guest ? h("p.acct-note.dim", null, SECOND_ACCOUNT_HELP) : null,
          canSignIn ? signInBtn : null,
          canSignIn ? signInBox : null,
        )
      : null;

  // --- support (apps/api src/supporters.ts): the thank-you for supporters (payments aren't open yet: the Support page).
  const since = support?.supporter ? new Date(support.supporter.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
  const supportSec = since ? h("section.acct-sec.acct-support", { id: "acct-support" }, h("h3", null, "Support"), h("p.acct-note", null, `Supporter since ${since}. Thank you.`)) : null;

  // --- the foot: replay the intro, sign out (held)
  const more = h(
    "footer.acct-foot",
    null,
    h("button.link-btn", { type: "button", onclick: () => { d.close(); void import("./privacy").then((m) => m.openPrivacyDialog()); } }, "Privacy & data"),
    getReplayIntro() ? h("button.link-btn", { type: "button", onclick: () => (d.close(), getReplayIntro()!()) }, "Replay the intro") : null,
    h("span.acct-foot-gap"),
    // The Wavedash build is always its Wavedash player: no signing out there.
    online && user && !guest && !WAVEDASH ? holdButton("Sign out everywhere", () => void signOut(true), { className: "btn-sm btn-ghost", title: "Hold to sign out on every device" }) : null,
    online && user && !guest && !WAVEDASH ? holdButton("Sign out", () => void signOut(false), { className: "btn-sm", title: "Hold to sign out. You can sign back in any time." }) : null,
    online && user && guest && !WAVEDASH ? holdButton("Start over as a new guest", () => void signOut(false), { className: "btn-sm btn-ghost", title: "This browser's guest runs stay with the old guest, and you can't get back to it." }) : null,
  );

  // Settings with the account (site), bringing a site account along (Wavedash build): ui/account-platform.ts.
  const extra = online && user ? platformSections({ guest, hasEmail: !!has("email") }) : [];
  body.replaceChildren(nameSec, ...(saveSec ? [saveSec] : []), ...extra, ...(supportSec ? [supportSec] : []), more);
  if (section === "save") (saveSec ?? nameSec).scrollIntoView({ block: "start" });
  if (section === "password") {
    pw?.open();
    (saveSec ?? nameSec).scrollIntoView({ block: "start" });
  }
  if (section === "support") supportSec?.scrollIntoView({ block: "start" });
  if (section === "name") requestAnimationFrame(() => (nf.input.focus(), nf.input.select()));

  async function signOut(everywhere: boolean) {
    await api.logout(everywhere).catch(() => undefined);
    location.reload();
  }
  async function rerender(next: AccountSection = null) {
    if (!d.open) return;
    await render(d, body, next);
  }
}
