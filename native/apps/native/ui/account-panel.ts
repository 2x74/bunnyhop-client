// Reuse account state, validation and email forms; account navigation stays in
// the menu document and OAuth is delegated to the separate native auth window.
import { api, type User } from "../../web/src/api";
import { accountAvatar, accountChanged, me } from "../../web/src/ui/account-state";
import { emailSignIn } from "../../web/src/ui/account-email";
import { nameField } from "../../web/src/ui/account-name";
import { h } from "../../web/src/ui/dom";
import { dismissOutside } from "../../web/src/ui/dismiss";
import { openAuth, LIVE_ORIGIN } from "./bridge";

export type AccountSection = "name" | "save" | "support" | null;
let open: HTMLDialogElement | null = null;

export function openAccountPanel(section: AccountSection = null): void {
  open?.close();
  const dialog = h("dialog.acct-dialog", { "aria-label": "Account" });
  const body = h("div.acct-body", null, h("p.dim", null, "Loading account…"));
  dialog.append(h("header.acct-head", null, h("h2", null, "Account"), h("button.acct-close", { type: "button", "aria-label": "Close account", onclick: () => dialog.close() }, "×")), body);
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dismissOutside(dialog, () => dialog.close());
  dialog.addEventListener("close", () => { dialog.remove(); if (open === dialog) open = null; });
  document.body.append(dialog); open = dialog; dialog.showModal();
  void paint();

  async function paint(): Promise<void> {
    const user = await me();
    const [providers, account] = await Promise.all([
      api.providers().catch(() => ({ discord: false, email: false })),
      user ? api.account().catch(() => null) : null,
    ]);
    if (!dialog.open) return;
    const current = account?.user ?? user;
    const guest = !current || current.provider === "guest";
    const note = h("p.native-account-note", { role: "status" });
    const changed = (next: User, message: string) => {
      accountChanged(next); note.textContent = message; void paint();
    };
    const identity = current
      ? h("div.native-identity", null, accountAvatar(current), h("div", null, h("strong", null, current.name), h("p.dim", null, guest ? "Guest account" : "Signed in")))
      : h("p.dim", null, "Account service is unavailable. Try again in a moment.");
    const parts: Node[] = [identity];
    if (current) {
      const field = nameField({ initial: current.name, onSaved: (next) => { if (next) changed(next, "Name saved."); } });
      parts.push(h("section.native-account-section", null, h("h3", null, "Display name"), field.el,
        h("button.btn", { type: "button", onclick: () => void field.save() }, "Save name")));
    }
    if(account&&!guest){
      for(const method of account.methods){const remove=h("button.link-btn",{type:"button",disabled:!account.canUnlink[method.provider]},`Unlink ${method.label}`);remove.onclick=async()=>{remove.disabled=true;try{const updated=await api.unlink(method.provider);changed(updated.user,"Sign-in method removed.");}catch(error){note.textContent=error instanceof Error?error.message:"Couldn't unlink this sign-in method.";remove.disabled=false;}};parts.push(remove);}
      if(current?.discordAvatarUrl&&!current.discordAvatarBlocked){const avatar=h("input",{type:"checkbox",checked:!!current.useDiscordAvatar,"aria-label":"Show Discord avatar"});avatar.onchange=async()=>{avatar.disabled=true;try{changed(await api.setUseDiscordAvatar(avatar.checked),"Avatar saved.");}catch{note.textContent="Couldn't update your avatar.";avatar.disabled=false;}};parts.push(h("label",null,avatar," Show Discord avatar"));}
    }
    const methods = account?.methods.map((method) => method.label).join(" · ");
    if (methods) parts.push(h("p.dim", null, `Sign-in methods: ${methods}`));
    if (providers.discord) {
      const url = api.discordLoginUrl(`${LIVE_ORIGIN}/?native=1`);
      parts.push(h("button.btn.discord", { type: "button", onclick: () => openAuth(url) }, guest ? "Sign in with Discord" : "Link Discord"));
    }
    if (providers.email) parts.push(h("section.native-account-section", null, h("h3", null, guest ? "Sign in with email" : "Link email"), emailSignIn({ onDone: changed, autofocus: section === "save" })));
    if (current && !guest) {
      const logout = h("button.btn", { type: "button" }, "Sign out");
      logout.addEventListener("click", async () => {
        logout.disabled = true;
        try { await api.logout(); accountChanged(); await paint(); }
        catch { note.textContent = "Couldn't sign out. Try again."; logout.disabled = false; }
      });
      parts.push(logout);
    }
    parts.push(note, h("button.link-btn", { type: "button", onclick: () => { accountChanged(); void paint(); } }, "Refresh account"));
    body.replaceChildren(...parts);
  }
}

/** The web dialog shell (ui/account-panel.ts modal), for the Inbox and Feedback dialogs the home screen opens. */
export function modal(cls: string, label: string, onClose?: () => void): HTMLDialogElement {
  const d = h("dialog", { class: cls, "aria-label": label }) as HTMLDialogElement;
  d.addEventListener("keydown", (e) => e.stopPropagation());
  dismissOutside(d, () => d.close());
  d.addEventListener("close", () => { d.remove(); onClose?.(); });
  document.body.append(d);
  return d;
}
