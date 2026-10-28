import { send, state } from "./bridge";

// "Practice from here" (web viewer practiceFromHere). The host takes the replay to the tick and carries on as a
// practice attempt, or leaves the replay playing and reports why it can't (another map or style, a gauntlet, a
// server). This keeps that reason next to the button, as the web viewer's notice does.

/** Host states to wait for before treating an unchanged error as this request's answer. */
const STALE_STATES = 1;

interface PendingRequest {
  replayId: string;
  errorBefore: string;
  statesSeen: number;
}

export class ReplayPractice {
  private pending: PendingRequest | null = null;
  private reason = "";
  private reasonReplayId = "";

  constructor(private readonly post: typeof send = send) {}

  /** `tick` is an absolute recording tick; without it the host uses the tick it is showing. */
  request(tick?: number): void {
    this.reason = "";
    this.pending = { replayId: state.playback.id, errorBefore: state.error ?? "", statesSeen: 0 };
    this.post(tick === undefined ? { type: "practiceFromReplay" } : { type: "practiceFromReplay", tick });
  }

  /** Call on every host state. */
  update(): void {
    const playback = state.playback;
    if (this.reasonReplayId !== playback.id) {
      this.reason = "";
    }
    const pending = this.pending;
    if (!pending) return;
    if (!playback.active || playback.id !== pending.replayId) {
      this.pending = null;
      return;
    }
    const error = state.error ?? "";
    const fresh = error !== pending.errorBefore || pending.statesSeen >= STALE_STATES;
    pending.statesSeen++;
    if (!error || !fresh) return;
    this.reason = error;
    this.reasonReplayId = playback.id;
    this.pending = null;
  }

  /** Why the last request was refused, for the replay that is still open. */
  message(): string {
    return this.reason;
  }
}

export const practiceFromReplay = new ReplayPractice();
