// Settings → the Profile menu at the top, by Export / Import (settings-profiles.ts has what a profile is and covers).
// One native select: the profiles (the active one marked when it's been changed since), then Save as new…, Rename… and
// Delete…. Picking a profile loads it at once; it only asks first when the current settings would be lost (changes not
// saved to the active profile, or settings no profile holds). A Save button shows beside it while the active profile is
// modified. The names and confirmations use the small dialogs of settings-transfer.ts.

import { h } from "./dom";
import { icon } from "./icons";
import { prefs } from "./settings";
import { confirmDialog, textDialog } from "./settings-transfer";
import { deleteProfile, findProfile, loadProfiles, nameProblem, PROFILE_NAME_MAX, profileModified, profilePlan, renameProfile, saveProfile, storeProfiles, type ProfileStore } from "./settings-profiles";

const NEW = "\u0000new";
const RENAME = "\u0000rename";
const DELETE = "\u0000delete";

export function profileMenu(o: { onApplied: () => void }): HTMLElement {
  const sel = h("select.select.set-profile", { "aria-label": "Settings profile", title: "Switch between saved setups" }) as HTMLSelectElement;
  const saveBtn = h("button.btn.btn-sm.btn-ghost.set-act.set-profile-save", { type: "button", hidden: true }, icon("check"), h("span", null, "Save"));
  const wrap = h("div.set-profile-row", null, sel, saveBtn);
  let store: ProfileStore = loadProfiles();

  const active = () => findProfile(store, store.active);
  const commit = () => {
    if (!storeProfiles(store)) console.warn("settings: profiles couldn't be saved in this browser");
  };

  function paint(): void {
    const cur = active();
    const modified = !!cur && profileModified(cur, prefs.get());
    const opt = (value: string, label: string) => h("option", { value }, label);
    sel.replaceChildren(
      ...(cur ? [] : [opt("", "No profile")]),
      ...store.list.map((p) => opt(p.name, p === cur && modified ? `${p.name} (modified)` : p.name)),
      h("hr"),
      opt(NEW, "Save as new…"),
      ...(cur ? [opt(RENAME, "Rename…"), opt(DELETE, "Delete…")] : []),
    );
    sel.value = cur?.name ?? "";
    sel.classList.toggle("modified", modified);
    saveBtn.hidden = !modified;
    saveBtn.title = cur ? `Save your changes to ${cur.name}` : "";
  }

  async function switchTo(name: string): Promise<void> {
    store = loadProfiles();
    const next = findProfile(store, name);
    if (!next) return paint();
    const cur = active();
    const now = prefs.get();
    const unsaved = cur ? profileModified(cur, now) : !store.list.some((p) => !profileModified(p, now));
    if (unsaved) {
      const ok = await confirmDialog({
        title: `Switch to ${next.name}?`,
        body: cur ? `Your changes to ${cur.name} aren't saved.` : "Your current settings aren't saved in a profile.",
        confirm: "Switch",
      });
      if (!ok) return paint();
    }
    const plan = profilePlan(next, prefs.get());
    store.active = next.name;
    commit();
    prefs.update((p) => Object.assign(p, plan.next));
    o.onApplied();
    paint();
  }

  async function saveAs(): Promise<void> {
    store = loadProfiles();
    const name = await textDialog({ title: "Save profile", label: "Profile name", confirm: "Save", maxLength: PROFILE_NAME_MAX, problem: (t) => nameProblem(store, t) });
    if (name === null) return;
    const over = findProfile(store, name);
    if (over && over !== active()) {
      const ok = await confirmDialog({ title: `Replace ${over.name}?`, body: `${over.name} gets your current settings.`, confirm: "Replace" });
      if (!ok) return;
    }
    saveProfile(store, name, prefs.get());
    commit();
    paint();
  }

  async function rename(): Promise<void> {
    store = loadProfiles();
    const cur = active();
    if (!cur) return paint();
    const name = await textDialog({ title: "Rename profile", label: "Profile name", confirm: "Rename", value: cur.name, maxLength: PROFILE_NAME_MAX, problem: (t) => nameProblem(store, t, cur.name) });
    if (name === null) return;
    renameProfile(store, cur.name, name);
    commit();
    paint();
  }

  async function remove(): Promise<void> {
    store = loadProfiles();
    const cur = active();
    if (!cur) return paint();
    const ok = await confirmDialog({ title: `Delete ${cur.name}?`, body: "Your settings stay as they are.", confirm: "Delete", danger: true });
    if (!ok) return;
    deleteProfile(store, cur.name);
    commit();
    paint();
  }

  sel.addEventListener("change", () => {
    const v = sel.value;
    paint(); // the selection shows the active profile until something else becomes active
    if (v === NEW) void saveAs();
    else if (v === RENAME) void rename();
    else if (v === DELETE) void remove();
    else if (v) void switchTo(v);
  });
  saveBtn.addEventListener("click", () => {
    store = loadProfiles();
    const cur = active();
    if (cur) saveProfile(store, cur.name, prefs.get());
    commit();
    paint();
    sel.focus({ preventScroll: true });
  });

  // Follows every change (a modified profile shows at once) while the screen is open.
  let shown = false;
  const stop = prefs.watch(() => {
    if (wrap.isConnected) shown = true;
    else if (shown) return void queueMicrotask(stop);
    paint();
  });
  return wrap;
}
