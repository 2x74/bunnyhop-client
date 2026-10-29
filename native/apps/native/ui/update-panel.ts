import { h } from "../../web/src/ui/dom";
import { api } from "../../web/src/api";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import type { Ui } from "./native-rows";
import { send } from "./bridge";
import { toast } from "./account-panel";
import type { VersionPolicy } from "./run-service";
import { rankedLine, rankedState, readUpdateStatus, type UpdateStatus } from "./update-status";

type UpdateAction = "check" | "download" | "cancel" | "reveal" | "restart" | "status";
const act = (action: UpdateAction) => () => send({ type: "update", action });

/** Release notes as plain lines: no markup from the release body is rendered. */
function notesLines(notes: string): HTMLElement[] {
  return notes
    .split("\n")
    .map((line) => line.replaceAll("**", "").trimEnd())
    .filter((line) => line.trim())
    .slice(0, 40)
    .map((line) => h("p.dim", null, line));
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** The open Settings → Updates panel, so the new-version toast isn't shown on top of it. */
let openPanel: HTMLElement | null = null;

/** Settings → Updates, kept in step with the host's "bunnyhop:update" status: the controls, then the notes. */
function updatesGroups(ui: Ui): HTMLElement[] {
  let current: UpdateStatus | null = null;
  let policy: VersionPolicy | null = null;
  const installed = h("small.set-readout");
  const message = h("small.set-readout", { role: "status" }, "Reading update status…");
  const ranked = h("small.set-readout");
  const notes = h("div.update-notes");
  const progress = h("progress", { max: 1, value: 0, hidden: true }) as HTMLProgressElement;
  const check = ui.button("Check for updates", act("check"), { disabled: true });
  const update = ui.button("Update", act("download"), { primary: true });
  const restart = ui.button("Restart to update", act("restart"), { primary: true });
  const cancel = ui.button("Cancel", act("cancel"));
  const reveal = ui.button("Open updates folder", act("reveal"));
  const rankedRow = ui.row("Ranked", ranked, { keywords: "ranked allowlist leaderboard" });
  const automatic = ui.toggle(
    "Check automatically",
    () => current?.automatic ?? true,
    (enabled) => send({ type: "update", action: "automatic", enabled }),
    { desc: "Checks once a day when the game starts. Nothing downloads until you press Update." },
  );
  const group = ui.group(
    "Desktop app",
    ui.row("Version", installed, { keywords: "version release build" }),
    ui.actions("Updates", [check, update, restart, cancel, reveal, progress], {
      readout: message,
      desc:
        "Releases are checked against the release signing key. Updating replaces the game's files only; " +
        "settings, replays and maps stay in your game data folder.",
      keywords: "update updates download release new version restart",
    }),
    rankedRow,
    automatic,
  );
  const notesGroup = ui.group("What's new", notes);
  const showRanked = (): void => {
    ranked.textContent = rankedLine(rankedState(policy, current?.build, current?.wasm));
  };
  const paint = (s: UpdateStatus): void => {
    const busy = s.status === "checking" || s.status === "downloading" || s.status === "staging";
    const offered = s.status === "available" || s.status === "staged" || s.status === "ready";
    const size = s.bytes && s.status === "available" ? ` · ${formatMegabytes(s.bytes)}` : "";
    installed.textContent = `Installed ${s.currentVersion}${s.version ? ` · Latest ${s.version}${size}` : ""}`;
    message.textContent = s.status === "available" && !s.inPlace ? `${s.message} ${s.inPlaceReason}` : s.message;
    check.disabled = busy || s.status === "disabled" || s.status === "restarting";
    update.hidden = s.status !== "available";
    update.textContent = s.inPlace ? "Update" : "Download";
    restart.hidden = s.status !== "staged";
    cancel.hidden = !busy || s.status === "checking";
    reveal.hidden = !s.packageSaved || s.status === "staged";
    progress.hidden = s.status !== "downloading";
    progress.value = s.bytes ? Math.min(1, s.received / s.bytes) : 0;
    notes.replaceChildren(...notesLines(offered ? s.notes : ""));
    notesGroup.hidden = !notes.childElementCount;
    rankedRow.hidden = !offered;
    if (offered && !policy) void loadPolicy();
    showRanked();
    ui.syncSwitches(group);
  };
  const loadPolicy = async (): Promise<void> => {
    try {
      policy = await api.version();
      showRanked();
    } catch {
      policy = null;
    }
  };
  const onStatus = (event: Event): void => {
    if (!group.isConnected && seen) return void removeEventListener("bunnyhop:update", onStatus);
    seen ||= group.isConnected;
    const status = readUpdateStatus((event as CustomEvent).detail);
    if (!status) return;
    current = status;
    paint(status);
  };
  let seen = false;
  addEventListener("bunnyhop:update", onStatus);
  queueMicrotask(act("status"));
  openPanel = group;
  return [group, notesGroup];
}

/** A small toast the first time each new version is found, unless Settings → Updates is already open. */
function noticeNewVersions(): void {
  const noticed = new Set<string>();
  addEventListener("bunnyhop:update", (event) => {
    const status = readUpdateStatus((event as CustomEvent).detail);
    if (status?.status !== "available" || !status.version || noticed.has(status.version)) return;
    noticed.add(status.version);
    if (!openPanel?.isConnected) toast(`Version ${status.version} is available. Settings → Updates.`, 8000);
  });
}

/** Registers Settings → Updates (call once). */
export function registerUpdatesSection(): void {
  registerSettingsSection("updates", (ui) => updatesGroups(ui), { label: "Updates", icon: "download", order: 95 });
  noticeNewVersions();
}
