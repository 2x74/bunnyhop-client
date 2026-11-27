// Private request intake; fulfilment and identity checks are handled by the developer.
import { api, ApiError, type PrivacyRequestKind } from "../api";
import { NOTE_REQUIRED, privacyRequestProblem } from "../privacy-request";
import { modal } from "./account-panel";
import { h } from "./dom";
import { SITE_ORIGIN, WAVEDASH } from "../platform/env";
import "../feedback/feedback.css";
import "./privacy.css";

let open: HTMLDialogElement | null = null;

export function openPrivacyDialog(): void {
  if (open) { open.focus(); return; }
  const opener = document.activeElement as HTMLElement | null;
  const d = modal("acct-dialog fb-dialog privacy-dialog", "Privacy & data", () => {
    open = null;
    if (opener?.isConnected) opener.focus();
  });
  open = d;
  let busy = false;
  let accountReady = false;
  let kind: PrivacyRequestKind = "export";
  const account = h("p.acct-note", { role: "status" }, "Loading current account…");
  const deletion = h("p.acct-note", { hidden: true }, 'Deletion is not instant. Signing out or “Start over as a new guest” is not deletion. Some records, such as payment or ban records, may be kept where required.');
  const choices: [PrivacyRequestKind, string][] = [
    ["export", "Send me a copy of my data"],
    ["delete", "Delete my account and data"],
    ["correct", "Correct something"],
    ["other", "Something else"],
  ];
  // v0.0.44 (TyZi): the note is the request for "correct" and "other", so it says so and is required there; the email
  // box is plain text with our own check (privacy-request.ts), so a note typed into it gets a clear line, not the
  // browser's @ rule.
  const noteLabel = h("label.fb-label", { for: "privacy-note" });
  const note = h("textarea.fb-text", { id: "privacy-note", rows: 4, maxlength: 2000 });
  const contact = h("input.fb-input", { id: "privacy-contact", type: "text", inputmode: "email", maxlength: 120, autocomplete: "email", spellcheck: "false", placeholder: "you@example.com" });
  const showKind = () => {
    const needed = NOTE_REQUIRED.includes(kind);
    deletion.hidden = kind !== "delete";
    noteLabel.textContent = needed ? "What do you need?" : "Note (optional)";
    note.placeholder = kind === "correct" ? "What's wrong and what it should be" : kind === "other" ? "Your question or request" : "";
    note.required = needed;
  };
  const radios = choices.map(([value, label]) => h("label.privacy-choice", null,
    h("input", { type: "radio", name: "privacy-kind", value, checked: value === kind, onchange: () => { kind = value; showKind(); error.textContent = ""; } }), label));
  const error = h("p.fb-err", { role: "alert" });
  showKind();
  const send = h("button.btn.primary", { type: "submit", disabled: true }, "Submit");
  const cancel = h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel");
  const form = h("form.fb-form", { novalidate: true },
    h("p.fb-ask", null, "Ask the developer for a copy of your data or to delete your account. Requests go only to the developer, not moderators. We may ask you to confirm the account is yours and aim to respond within 30 days."),
    account,
    h("fieldset.privacy-choices", null, h("legend.fb-label", null, "Your request"), ...radios),
    deletion,
    h("div.fb-field", null, noteLabel, note),
    h("div.fb-field", null, h("label.fb-label", { for: "privacy-contact" }, "Email for replies (optional)"), contact, h("p.acct-note", null, "Without one we reply in your in-game inbox")),
    error,
    h("div.fb-actions", null, cancel, send),
    h("p.acct-note", null, h("a", { href: WAVEDASH ? `${SITE_ORIGIN}/privacy` : "/privacy", target: "_blank", rel: "noopener" }, "Privacy policy"), " · Or email ", h("a", { href: "mailto:support@bunnyhop.lol" }, "support@bunnyhop.lol")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || !accountReady) return;
    const problem = privacyRequestProblem(kind, note.value, contact.value);
    if (problem) {
      error.textContent = problem.message;
      (problem.field === "note" ? note : contact).focus();
      return;
    }
    busy = true;
    send.disabled = true;
    send.textContent = "Sending…";
    error.textContent = "";
    // Freeze the form so its displayed request cannot change during submission.
    for (const input of [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]) input.disabled = true;
    try {
      const r = await api.sendPrivacyRequest({ kind, note: note.value.trim(), contact: contact.value.trim() });
      const close = h("button.btn.primary", { type: "button", onclick: () => d.close() }, "Close");
      form.replaceChildren(h("div", { role: "status" }, h("h3", null, "Request received"), h("p.acct-note", null, "The developer will review your request. This is a receipt, not confirmation that your data has been exported or deleted."), h("p.fb-ref", null, "Request id: ", h("code", null, r.id))), close);
      close.focus();
    } catch (x) {
      error.textContent = x instanceof ApiError ? x.message : "Couldn't reach the server. Try again, or email support@bunnyhop.lol.";
      busy = false;
      send.disabled = false;
      send.textContent = "Submit";
      for (const input of [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]) input.disabled = false;
    }
  });
  d.append(h("header.acct-head", null, h("h2", null, "Privacy & data"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, "×")), h("div.acct-body", null, form));
  d.showModal();
  radios[0].querySelector("input")?.focus();
  void api.me().then((user) => {
    if (!d.open) return;
    account.replaceChildren(...(user ? [document.createTextNode(`${api.meStale() ? "Last known account" : "Current account"}: ${user.name} (${user.provider}) · `), h("code", null, user.id), document.createTextNode(api.meStale() ? ". We couldn't verify the current session; leave an email if you need a reply." : ". Keep access to this account to read inbox replies.")] : [document.createTextNode("No signed-in account. Leave an email for a reply and describe the account in your note; the developer will verify ownership.")]));
  }).catch(() => { account.textContent = "Account unavailable. Leave an email for a reply, or contact support@bunnyhop.lol."; }).finally(() => { accountReady = true; if (d.open) send.disabled = false; });
}
