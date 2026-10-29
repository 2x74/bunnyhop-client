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
