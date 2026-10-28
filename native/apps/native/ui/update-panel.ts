import {h} from "../../web/src/ui/dom";
import {registerSettingsSection} from "../../web/src/ui/settings-registry";
import type {Ui} from "./native-rows";
import {send} from "./bridge";
export interface UpdateStatus {status:string;message:string;currentVersion:string;version?:string;received:number;bytes?:number}
export function readUpdateStatus(value:unknown):UpdateStatus|null {
 if(!value||typeof value!=="object")return null;const v=value as Record<string,unknown>;
 if(typeof v.status!=="string"||!["disabled","idle","checking","available","current","downloading","ready","cancelled","error"].includes(v.status))return null;
 return {status:v.status,message:typeof v.message==="string"?v.message.slice(0,1000):"",currentVersion:typeof v.currentVersion==="string"?v.currentVersion.slice(0,80):"local",version:typeof v.version==="string"?v.version.slice(0,80):undefined,received:typeof v.received==="number"&&Number.isFinite(v.received)?Math.max(0,v.received):0,bytes:typeof v.bytes==="number"&&Number.isFinite(v.bytes)&&v.bytes>0?v.bytes:undefined};
}
type UpdateAction = "check" | "download" | "cancel" | "reveal";
const act = (action: UpdateAction) => () => send({ type: "update", action });

/** Settings → Updates, kept in step with the host's "bunnyhop:update" status. */
function updatesGroup(ui: Ui): HTMLElement {
  const installed = h("small.set-readout");
  const message = h("small.set-readout", { role: "status" }, "Reading update status…");
  const progress = h("progress", { max: 1, value: 0, hidden: true }) as HTMLProgressElement;
  const check = ui.button("Check for updates", act("check"), { disabled: true });
  const download = ui.button("Download", act("download"), { primary: true });
  const cancel = ui.button("Cancel", act("cancel"));
  const reveal = ui.button("Open updates folder", act("reveal"));
  const group = ui.group(
    "Desktop app",
    ui.row("Version", installed, { keywords: "version release build" }),
    ui.actions("Updates", [check, download, cancel, reveal, progress], {
      readout: message,
      desc:
        "Downloads are checked against the release signing key. " +
        "Installing is manual: close the game before replacing the app.",
      keywords: "update updates download release new version",
    }),
  );
  download.hidden = cancel.hidden = reveal.hidden = true;
  const paint = (s: UpdateStatus): void => {
    const busy = s.status === "checking" || s.status === "downloading";
    installed.textContent = `Installed ${s.currentVersion}${s.version ? ` · Latest ${s.version}` : ""}`;
    message.textContent = s.message;
    check.disabled = busy || s.status === "disabled";
    download.hidden = s.status !== "available";
    cancel.hidden = !busy;
    reveal.hidden = s.status !== "ready";
    progress.hidden = s.status !== "downloading";
    progress.value = s.bytes ? Math.min(1, s.received / s.bytes) : 0;
  };
  const onStatus = (event: Event): void => {
    if (!group.isConnected && seen) return void removeEventListener("bunnyhop:update", onStatus);
    seen ||= group.isConnected;
    const status = readUpdateStatus((event as CustomEvent).detail);
    if (status) paint(status);
  };
  let seen = false;
  addEventListener("bunnyhop:update", onStatus);
  queueMicrotask(() => send({ type: "update", action: "status" }));
  return group;
}

/** Registers Settings → Updates (call once). */
export function registerUpdatesSection(): void {
  registerSettingsSection("updates", (ui) => [updatesGroup(ui)], { label: "Updates", icon: "download", order: 95 });
}
