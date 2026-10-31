import { h } from "../../web/src/ui/dom";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import type { Ui } from "./native-rows";
import { send } from "./bridge";

/** Settings -> Game data, mirrored from the host (client.cpp "dataFolder"). */
export interface DataFolderStatus {
  path: string;
  defaultPath: string;
  isDefault: boolean;
  configured: string;
  unavailable: boolean;
  pending: string | null;
  picking: boolean;
  notice: string;
  choice: { path: string; problem: string } | null;
}
const str = (v: unknown, max = 4096): string | null => (typeof v === "string" ? v.slice(0, max) : null);
export function readDataFolderStatus(value: unknown): DataFolderStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const path = str(v.path),
    defaultPath = str(v.defaultPath),
    configured = str(v.configured) ?? path;
  if (!path || !defaultPath || configured === null || typeof v.isDefault !== "boolean") return null;
  let choice: DataFolderStatus["choice"] = null;
  if (v.choice && typeof v.choice === "object") {
    const c = v.choice as Record<string, unknown>;
    const cp = str(c.path),
      problem = str(c.problem, 1000);
    if (cp !== null && problem !== null) choice = { path: cp, problem };
  }
  return {
    path,
    defaultPath,
    isDefault: v.isDefault,
    configured,
    unavailable: v.unavailable === true,
    pending: str(v.pending),
    picking: v.picking === true,
    notice: str(v.notice, 1000) ?? "",
    choice,
  };
}

type DataAction = "pick" | "useDefault" | "reveal" | "revealLogs" | "forget" | "cancelPending" | "cancelChoice";
const act = (action: DataAction) => () => send({ type: "dataFolder", action });
const move = (when: "now" | "later") => () => send({ type: "dataFolder", action: "move", when });

/** The rows of Settings → Game data, kept in step with the host's "bunnyhop:data-folder" status. */
function dataFolderGroup(ui: Ui): HTMLElement {
  const path = h("code.native-data-path", null, "…");
  const readout = h("small.set-readout");
  const where = h("span");
  const change = ui.button("Change folder…", act("pick"));
  const useDefault = ui.button("Move back to the default", act("useDefault"));
  const reveal = ui.button("Open folder", act("reveal"));
  const forget = ui.button("Use the default from now on", act("forget"));
  const cancelPending = ui.button("Cancel move", act("cancelPending"));
  const question = h("small.set-readout");
  const moveNow = ui.button("Move now", move("now"), { primary: true, title: "Restarts the game" });
  const moveLater = ui.button("Next launch", move("later"));
  const pickAgain = ui.button("Pick another folder", act("pick"));
  const cancelChoice = ui.button("Cancel", act("cancelChoice"));
  const folderRow = ui.actions("Folder", [change, reveal], {
    readout,
    desc:
      "Maps and other downloads, replays, settings and your sound/ and bgm/ folders live here. " +
      "Your login stays where it is.",
    keywords: "data folder directory path storage maps replays disk drive change open reveal",
  });
  readout.append(path, " ", where);
  const defaultRow = ui.actions("Default folder", [useDefault], { keywords: "data folder default move back" });
  const moveRow = ui.actions("Move game data", [moveNow, moveLater, pickAgain, cancelChoice], {
    readout: question,
    desc: "Moves happen while the game starts, so nothing is in use.",
    keywords: "data folder move",
  });
  const pendingRow = ui.actions("Waiting to move", [cancelPending], { keywords: "data folder move pending" });
  const missingRow = ui.actions("Folder not found", [forget], { keywords: "data folder missing drive" });
  const logRow = ui.actions("Log file", [ui.button("Open log folder", act("revealLogs"))], {
    readout: h("small.set-readout", null, "If we ask for your log, send us bunnyhop-native.log from this folder."),
    keywords: "log logs file crash bug report problem support troubleshooting send",
  });
  const group = ui.group("Game data folder", folderRow, defaultRow, moveRow, pendingRow, missingRow, logRow);
  moveRow.hidden = pendingRow.hidden = missingRow.hidden = defaultRow.hidden = true;
  const paint = (s: DataFolderStatus): void => {
    path.textContent = s.path;
    const note = s.notice || (s.isDefault ? "Default" : "");
    where.textContent = s.picking ? "Choose a folder in the window that opened…" : note;
    missingRow.hidden = !s.unavailable;
    if (s.unavailable) setReadout(missingRow, `${s.configured} isn't there. Using the default folder this session.`);
    pendingRow.hidden = !s.pending;
    if (s.pending) setReadout(pendingRow, `Moves to ${s.pending} the next time the game starts.`);
    change.disabled = s.picking || s.unavailable;
    defaultRow.hidden = s.isDefault || s.unavailable;
    moveRow.hidden = !s.choice;
    const ok = !!s.choice && !s.choice.problem;
    question.textContent = s.choice ? (ok ? `Move everything to ${s.choice.path}?` : s.choice.problem) : "";
    moveNow.hidden = moveLater.hidden = !ok;
    pickAgain.hidden = ok;
  };
  const onStatus = (event: Event): void => {
    if (!group.isConnected && seen) return void removeEventListener("bunnyhop:data-folder", onStatus);
    seen ||= group.isConnected;
    const status = readDataFolderStatus((event as CustomEvent).detail);
    if (status) paint(status);
  };
  let seen = false;
  addEventListener("bunnyhop:data-folder", onStatus);
  queueMicrotask(() => send({ type: "dataFolder", action: "status" }));
  return group;
}

function setReadout(row: HTMLElement, text: string): void {
  const label = row.querySelector(".set-label")!;
  const readout = label.querySelector(".set-readout") ?? label.appendChild(h("small.set-readout"));
  readout.textContent = text;
}

/** Registers Settings → Game data (call once). */
export function registerDataFolderSection(): void {
  registerSettingsSection("data", (ui) => [dataFolderGroup(ui)], { label: "Game data", icon: "file", order: 85 });
}
