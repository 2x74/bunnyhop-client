// What the reused menu modules import from the web HUD (hud.ts, which draws the web game's HUD and is never part of
// the native menu): the gauntlet modules' SubmissionView, same shape as hud.ts, and the settings panel's crosshair.
import type { Submission } from "../../web/src/api";

export { renderCrosshair } from "./crosshair";

export type UploadFailure = "too_large" | "network" | "interrupted" | "guest_limit";

export type SubmissionView =
  | Submission
  | { status: "local" }
  | { status: "submitting" }
  | { status: "error"; reason?: string }
  | { status: "unsent"; failure: UploadFailure };
