// The update state the host sends with "bunnyhop:update", read defensively, and what the ranked line says about a
// new build. No DOM here, so Bun tests can import it.
import { nativeBuildAllowed, type VersionPolicy } from "./run-service";

const PHASES = [
  "disabled",
  "idle",
  "checking",
  "available",
  "current",
  "downloading",
  "staging",
  "staged",
  "ready",
  "restarting",
  "cancelled",
  "error",
] as const;
export type UpdatePhase = (typeof PHASES)[number];

export interface UpdateStatus {
  status: UpdatePhase;
  message: string;
  currentVersion: string;
  version?: string;
  notes: string;
  build?: string;
  wasm?: string;
  received: number;
  bytes?: number;
  /** This copy can replace itself; otherwise the package is saved for a manual install. */
  inPlace: boolean;
  inPlaceReason: string;
  packageSaved: boolean;
  automatic: boolean;
}

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" ? value.slice(0, limit) : undefined;
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function readUpdateStatus(value: unknown): UpdateStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!PHASES.includes(v.status as UpdatePhase)) return null;
  const bytes = count(v.bytes);
  return {
    status: v.status as UpdatePhase,
    message: text(v.message, 1000) ?? "",
    currentVersion: text(v.currentVersion, 80) ?? "local",
    version: text(v.version, 80),
    notes: text(v.notes, 8192) ?? "",
    build: text(v.build, 80),
    wasm: text(v.wasm, 80),
    received: Math.max(0, count(v.received)),
    bytes: bytes > 0 ? bytes : undefined,
    inPlace: v.inPlace === true,
    inPlaceReason: text(v.inPlaceReason, 300) ?? "",
    packageSaved: v.packageSaved === true,
    automatic: v.automatic !== false,
  };
}

export type RankedState = "unknown" | "allowed" | "waiting";

/** Whether the server already lists the new build for ranked runs. A missing identity or policy is "unknown". */
export function rankedState(
  policy: VersionPolicy | null,
  build?: string,
  wasm?: string,
  now = Date.now(),
): RankedState {
  if (!policy || !build || !wasm) return "unknown";
  return nativeBuildAllowed(policy, { build, wasm }, now) ? "allowed" : "waiting";
}

export function rankedLine(state: RankedState): string {
  if (state === "allowed") return "This version can submit ranked runs.";
  if (state === "waiting")
    return "The server doesn't list this version yet. Until it does, runs are kept locally and not ranked.";
  return "A new version can submit ranked runs once the server lists it.";
}

/** What the home screen's update line says and the one action it offers. */
export interface UpdatePromptView {
  text: string;
  action: "download" | "cancel" | "restart" | "reveal" | "check" | null;
  label: string;
  /** "Not now" hides the line until a newer version. */
  dismissible: boolean;
}

/**
 * The home screen's line for an update status, or null when there's nothing to offer. `dismissed` is the version
 * put off with "Not now"; `attempted` the version this line started downloading, so a failed download says so.
 */
export function updatePromptView(
  status: UpdateStatus | null,
  dismissed: string | null,
  attempted: string | null,
): UpdatePromptView | null {
  if (!status) return null;
  const version = status.version;
  const failed = status.status === "error" || status.status === "cancelled";
  if (failed && attempted) {
    const text =
      status.status === "cancelled" ? "The update was cancelled." : `The update didn't finish. ${status.message}`;
    return { text: text.trim(), action: "check", label: "Try again", dismissible: true };
  }
  if (!version || version === dismissed) return null;
  switch (status.status) {
    case "available":
      return {
        text: `Version ${version} is out.`,
        action: "download",
        label: status.inPlace ? "Update" : "Download",
        dismissible: true,
      };
    case "downloading": {
      const percent = status.bytes ? Math.floor((100 * status.received) / status.bytes) : 0;
      return {
        text: `Downloading version ${version}… ${percent}%`,
        action: "cancel",
        label: "Cancel",
        dismissible: false,
      };
    }
    case "staging":
      return { text: `Checking version ${version}…`, action: null, label: "", dismissible: false };
    case "staged":
      return { text: `Version ${version} is ready.`, action: "restart", label: "Restart to update", dismissible: true };
    case "ready":
      return {
        text: `Version ${version} is downloaded. Close the game, then install it from the updates folder.`,
        action: "reveal",
        label: "Open updates folder",
        dismissible: true,
      };
    case "restarting":
      return { text: "Restarting to update…", action: null, label: "", dismissible: false };
    default:
      return null;
  }
}
