// Types the reused gauntlet modules import from the web HUD (hud.ts, which draws the web game's HUD and is never part of
// the native menu). Same shape as hud.ts SubmissionView.
import type { Submission } from "../../web/src/api";

export type UploadFailure = "too_large" | "network" | "interrupted" | "guest_limit";

export type SubmissionView =
  | Submission
  | { status: "local" }
  | { status: "submitting" }
  | { status: "error"; reason?: string }
  | { status: "unsent"; failure: UploadFailure };
