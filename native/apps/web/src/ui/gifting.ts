import "./gifting.css";
import "./account.css";
import { api, ApiError } from "../api";
import { GIFTER_BOW, GIFTER_PATH, GIFTER_TIERS } from "../creators";
import { GIFT_MAX_RECIPIENTS, type GiftPreview, type GiftTarget, type GiftWallet } from "../gifting";
import { me, refreshMyProfile, accountGeneration, onAccountChange } from "./account-state";
import { h } from "./dom";
import { profileWriteGuard } from "./profile-write";
import { dismissOutside } from "./dismiss";

/** A small credit coin, distinct from the transparent earned Gifter badge. */
export function giftCreditCoin(): HTMLElement {
  return h("span.gift-credit-coin", { "aria-hidden": "true", html: `<svg viewBox="0 0 32 32" focusable="false"><circle cx="16" cy="16" r="14" fill="#dca63a" stroke="#080a0e" stroke-width="1.2"/><circle cx="16" cy="16" r="11.5" fill="#f2c45d" stroke="#9c681f" stroke-width="1"/><g transform="translate(7 7) scale(.75)" fill="#5a3717"><path d="${GIFTER_BOW}" fill-rule="evenodd"/><path d="${GIFTER_PATH}"/></g></svg>` });
}

export interface GiftDialogOptions {
  recipientId?: string;
  recipientName?: string;
  roomId?: string;
  onDelivered?: () => void;
}

let current: HTMLDialogElement | null = null;
// Retain an uncertain operation across closing/reopening the dialog. Retrying uses the same server idempotency key.
const pending = new Map<string, { id: string; maxCost: number }>();
function pendingGift(key: string): { id: string; maxCost: number } | undefined {
  if (pending.has(key)) return pending.get(key);
  try {
    const stored = JSON.parse(sessionStorage.getItem(`bunnyhop:gift:${key}`) ?? "null");
    if (stored && typeof stored.id === "string" && Number.isInteger(stored.maxCost) && stored.maxCost > 0 && stored.maxCost <= GIFT_MAX_RECIPIENTS) {
      pending.set(key, stored);
      return stored;
    }
  } catch { /* Storage can be disabled. The in-memory retry key still works. */ }
  return undefined;
}
function rememberGift(key: string, operation: { id: string; maxCost: number } | null): void {
  if (operation) pending.set(key, operation);
  else pending.delete(key);
  try {
    if (operation) sessionStorage.setItem(`bunnyhop:gift:${key}`, JSON.stringify(operation));
    else sessionStorage.removeItem(`bunnyhop:gift:${key}`);
  } catch { /* In-memory fallback. */ }
}

/** A server-priced confirmation, never a gift on the first click. */
export function openGiftDialog(o: GiftDialogOptions = {}): void {
  if (current?.open) { current.focus(); return; }
  document.exitPointerLock?.();
  const dialog = h("dialog.acct-dialog.gift-dialog", { "aria-labelledby": "gift-title" });
  current = dialog;
  const generation=accountGeneration();
  const currentAccount=()=>generation===accountGeneration();
  let busy = false;
  let revision = 0;
  let preview: GiftPreview | null = null;
  let reviewed: GiftTarget | null = null;
  let userId = "";
  let write:ReturnType<typeof profileWriteGuard>|undefined;
  let wallet: GiftWallet | null = null;
  const status = h("p.gift-status", { role: "status", "aria-live": "polite" }, "Loading your gift credits…");
  const balance = h("span.gift-balance", { "aria-label": "Available gift credits" });
  const review = h("div.gift-review", { hidden: true });
  const controls = h("fieldset.gift-controls", { disabled: true });
  // Who gets it: one button per choice this dialog was opened with (a player's profile, a server, or neither).
  type Mode = "direct" | "lobby" | "random-lobby" | "random-public";
  const modes: [Mode, string][] = [
    ...(o.recipientId ? [["direct", o.recipientName ?? "This player"] as [Mode, string]] : []),
    ...(o.roomId ? [["lobby", "Everyone here"], ["random-lobby", "Random here"]] as [Mode, string][] : []),
    ["random-public", o.roomId || o.recipientId ? "Random anywhere" : "Random players"],
  ];
  const mode = { value: modes[0][0] as Mode };
  const modeBar = h(`div.gift-modes${modes.length === 4 ? ".grid" : ""}`, { role: "radiogroup", "aria-label": "Who gets it" });
  const drawModes = () => modeBar.replaceChildren(...modes.map(([value, label]) => h(`button.gift-mode${value === mode.value ? ".on" : ""}`, {
    type: "button", role: "radio", "aria-checked": String(value === mode.value),
    onclick: () => { if (value === mode.value) return; mode.value = value; drawModes(); updateScope(); invalidate(); },
  }, label)));
  const quantity = h("input.es-input.gift-count", { type: "number", min: "1", max: String(GIFT_MAX_RECIPIENTS), step: "1", value: "1", inputmode: "numeric", "aria-label": "Number of gifts" }) as HTMLInputElement;
  const step = (by: number) => {
    const n = Number(quantity.value);
    // + stops at your credits once they're known.
    const most = Math.min(GIFT_MAX_RECIPIENTS, Math.max(1, wallet?.credits ?? GIFT_MAX_RECIPIENTS));
    quantity.value = String(Math.max(1, Math.min(most, (Number.isInteger(n) ? n : 1) + by)));
    invalidate();
  };
  const quantityLabel = h("div.gift-quantity", null, h("span", null, "Gifts"),
    h("div.gift-stepper", null, h("button.btn", { type: "button", "aria-label": "One fewer", onclick: () => step(-1) }, "−"), quantity, h("button.btn", { type: "button", "aria-label": "One more", onclick: () => step(1) }, "+")));
  const choose = h("button.btn.primary", { type: "button" }, "Continue");
  const send = h("button.btn.primary", { type: "button", hidden: true }, "Send gift");
  const close = h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => { if (!busy) dialog.close(); } }, "×");
  const target = (): GiftTarget => {
    if (mode.value === "direct" && o.recipientId) return { mode: "direct", recipientId: o.recipientId };
    if (mode.value === "lobby" && o.roomId) return { mode: "lobby", roomId: o.roomId };
    const count = Number(quantity.value);
    if (!Number.isInteger(count) || count < 1 || count > GIFT_MAX_RECIPIENTS) throw new Error(`Choose between 1 and ${GIFT_MAX_RECIPIENTS} gifts.`);
    return mode.value === "random-lobby" && o.roomId ? { mode: "random", scope: "lobby", roomId: o.roomId, count } : { mode: "random", scope: "public", count };
  };
  const setBusy = (on: boolean) => {
    busy = on;
    controls.disabled = on;
    send.disabled = close.disabled = on;
  };
  const showWallet = (w: GiftWallet) => {
    wallet = w;
    balance.replaceChildren(giftCreditCoin(), `${w.credits} credit${w.credits === 1 ? "" : "s"} available`);
  };
  // A guest's identity can change when linking an existing account. Only recover
  // aliases confirmed by the server, never another account's pending purchase.
  const operationKey = (wanted: GiftTarget): string => {
    const suffix = JSON.stringify(wanted);
    for (const owner of [userId, ...(wallet?.mergedUserIds ?? [])]) {
      const key = `${owner}:${suffix}`;
      if (pendingGift(key)) return key;
    }
    return `${userId}:${suffix}`;
  };
  const invalidate = () => {
    revision++;
    preview = null;
    reviewed = null;
    review.hidden = send.hidden = true;
    choose.disabled = false;
    choose.hidden = false;
    quantityLabel.hidden = !mode.value.startsWith("random");
    status.textContent = "";
    if (userId) {
      try {
        const wanted = target();
        const retry = pendingGift(operationKey(wanted));
        if (retry) {
          choose.disabled = true;
          choose.hidden = true;
          reviewed = wanted;
          preview = { cost: retry.maxCost, eligibleCount: retry.maxCost, linkedCount: 0, guestCount: 0, credits: wallet?.credits ?? 0, canDeliver: true };
          review.replaceChildren(h("p", null, "Your last gift didn't confirm. Retry it: you won't be charged twice."), h("strong.gift-cost", null, giftCreditCoin(), `Up to ${retry.maxCost} credit${retry.maxCost === 1 ? "" : "s"}`));
          review.hidden = send.hidden = false;
          send.textContent = "Retry gift";
        }
      } catch { /* An incomplete quantity is validated when Review is pressed. */ }
    }
  };
  quantity.addEventListener("input", invalidate);
  choose.addEventListener("click", async () => {
    if (!currentAccount()) { dialog.close(); return; }
    if (busy || choose.disabled) return;
    try {
      const wanted = target();
      const seq = ++revision;
      setBusy(true);
      status.textContent = "Checking…";
      preview = await api.giftPreview(wanted,write);
      if (!dialog.isConnected || seq !== revision || !currentAccount()) return;
      reviewed = wanted;
      balance.replaceChildren(giftCreditCoin(), `${preview.credits} credit${preview.credits === 1 ? "" : "s"} available`);
      const players = `${preview.cost} ${wanted.mode === "random" ? "random " : ""}player${preview.cost === 1 ? "" : "s"}`;
      const recipient = wanted.mode === "direct" ? o.recipientName ?? "This player" : players;
      review.replaceChildren(
        h("div.gift-summary", null, h("span", null, h("strong", null, recipient), " get", wanted.mode === "direct" ? "s" : "", " Supporter"), h("strong.gift-cost", null, giftCreditCoin(), `${preview.cost} credit${preview.cost === 1 ? "" : "s"}`)),
      );
      const ok = preview.canDeliver && preview.cost > 0;
      review.hidden = send.hidden = !ok;
      choose.hidden = ok;
      send.textContent = preview.cost === 1 ? "Send gift" : `Send ${preview.cost} gifts`;
      status.textContent = ok ? "" : preview.eligibleCount === 0 ? (wanted.mode === "direct" ? "They can't get a gift: they're already a supporter or not eligible." : "Nobody can get a gift right now. Supporters are skipped.") : preview.eligibleCount < preview.cost ? `Only ${preview.eligibleCount} player${preview.eligibleCount === 1 ? " is" : "s are"} eligible. Choose fewer gifts.` : `Not enough credits: you have ${preview.credits}.`;
      if (!send.hidden) send.focus();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Couldn't review this gift. Try again.";
    } finally { setBusy(false); }
  });
  send.addEventListener("click", async () => {
    if (!currentAccount()) { dialog.close(); return; }
    if (busy || !reviewed || !preview?.canDeliver || !userId) return;
    const key = operationKey(reviewed);
    const operation = pendingGift(key) ?? { id: crypto.randomUUID(), maxCost: preview.cost };
    rememberGift(key, operation);
    setBusy(true);
    status.textContent = "Sending…";
    try {
      const delivered = await api.sendGifts(reviewed, operation.id, operation.maxCost,write);
      if(!currentAccount()||!dialog.isConnected)return;
      rememberGift(key, null);
      showWallet(delivered.wallet);
      review.replaceChildren(h("strong", null, `${delivered.cost === 1 ? "Gift" : `${delivered.cost} gifts`} sent. Thank you!`), h("p", null, delivered.delivered.map((p) => p.name).join(", ")));
      status.textContent = "";
      send.hidden = true;
      choose.textContent = "Gift again";
      preview = null;
      reviewed = null;
      choose.disabled = false;
      choose.hidden = false;
      refreshMyProfile();
      window.dispatchEvent(new Event("bunnyhop:gifts-changed"));
      o.onDelivered?.();
    } catch (error) {
      const definitelyRejected = new Set(["no_eligible_recipients", "too_many_recipients", "stale_preview", "gift_cost_changed", "insufficient_gift_credits", "gift_recipient_changed"]);
      if (error instanceof ApiError && definitelyRejected.has(error.code)) {
        rememberGift(key, null);
        send.hidden = true;
        preview = null;
        reviewed = null;
        choose.disabled = false;
        choose.hidden = false;
        status.textContent = error.message;
      } else {
        // Delivery may have committed before the connection failed. Reuse its id instead of issuing another gift.
        send.textContent = "Retry gift";
        choose.disabled = true;
        choose.hidden = true;
        status.textContent = error instanceof ApiError ? `${error.message} Retry when you can: you won't be charged twice.` : "Couldn't confirm the gift. Retry it: you won't be charged twice.";
      }
    } finally { setBusy(false); }
  });
  const scopeHint = h("p.dim.gift-scope");
  const updateScope = () => {
    scopeHint.textContent = {
      direct: "Permanent Supporter, even if they're a guest. One credit.",
      lobby: "Everyone in this server who isn't a supporter yet. One credit each.",
      "random-lobby": "Picked at random from players in this server. One credit each.",
      "random-public": "Picked at random from players across the game, online or offline. Signed-in players come first, and regulars are more likely to be picked.",
    }[mode.value];
  };
  updateScope();
  drawModes();
  controls.append(...(modes.length > 1 ? [modeBar] : []), scopeHint, quantityLabel, choose);
  dialog.append(h("header.acct-head", null, h("div.gift-heading", null, h("h2#gift-title", null, "Gift Supporter"), balance), close), h("div.acct-body", null,
    controls, review, send, status));
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  dialog.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  dismissOutside(dialog, () => { if (!busy) dialog.close(); });
  dialog.addEventListener("close", () => { revision++; current = null; dialog.remove(); });
  document.body.append(dialog);
  onAccountChange(dialog,()=>{revision++;dialog.close();});
  invalidate();
  dialog.showModal();
  void me().then(async (u) => {
    if (!u) throw new Error("Connect to your account to use gifting.");
    if(!currentAccount()||!dialog.isConnected)return;
    userId = u.id;write=profileWriteGuard(userId);
    const w = await api.giftWallet();
    if (!dialog.isConnected || !currentAccount()) return;
    showWallet(w);
    controls.disabled = false;
    invalidate();
    status.textContent = reviewed || wallet?.credits ? "" : "No gift credits yet. Every full $5 you give after your first $5 is one.";
  }).catch((error: unknown) => { if (dialog.isConnected) status.textContent = error instanceof Error ? error.message : "Couldn't load your gift credits."; });
}

/** The Support page's gift credits: the balance, the button to send them, and progress to the next Gifter badge. */
export function giftWalletPanel(): HTMLElement {
  const amount = h("strong.gift-credit-amount", null, giftCreditCoin(), "Gift credits");
  const progress = h("progress.gift-tier-progress", { max: 1, value: 0, "aria-label": "Progress to the next Gifter badge" });
  const goal = h("span.gift-tier-goal");
  const track = h("div.gift-tier-track", { hidden: true }, progress, goal);
  const detail = h("p.gift-wallet-note", null, "Loading…");
  const open = h("button.btn.primary", { type: "button", disabled: true, onclick: () => openGiftDialog() }, "Gift Supporter");
  const panel = h("section.sp-gifts", { "aria-label": "Your gift credits" }, h("div.sp-gifts-top", null, amount, open), track, detail);
  let refreshSeq=0;
  const refresh = () => {const generation=accountGeneration(),seq=++refreshSeq;open.disabled=true;return void me().then((u) => u ? api.giftWallet() : null).then((w) => {
    if(generation!==accountGeneration()||seq!==refreshSeq)return;
    if (!w) { track.hidden = true; detail.hidden = false; detail.textContent = "Sign in to see your gift credits."; return; }
    amount.replaceChildren(giftCreditCoin(), `${w.credits} gift credit${w.credits === 1 ? "" : "s"}`);
    const next = GIFTER_TIERS.find(t => t.goal === w.nextTier);
    progress.max = next ? next.goal - w.tier : 1;
    progress.value = next ? Math.max(0, Math.min(progress.max, w.giftsSent - w.tier)) : 1;
    const label = next ? `${w.giftsSent} of ${next.goal} gifts to ${next.name}` : `${w.giftsSent} gifts sent. Prism Gifter`;
    progress.setAttribute("aria-valuetext", label);
    goal.textContent = label;
    track.hidden = false;
    detail.hidden = true;
    open.disabled = false;
  }).catch(() => {if(generation!==accountGeneration()||seq!==refreshSeq)return;track.hidden = true; detail.hidden = false; detail.textContent = "Couldn't load your gift credits."; open.disabled = false; });};
  const changed = () => { if (!panel.isConnected) window.removeEventListener("bunnyhop:gifts-changed", changed); else refresh(); };
  window.addEventListener("bunnyhop:gifts-changed", changed);
  onAccountChange(panel,refresh);
  refresh();
  return panel;
}
