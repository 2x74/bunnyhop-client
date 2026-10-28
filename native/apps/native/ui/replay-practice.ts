import { send, state } from "./bridge";

// "Practice from here" (web viewer practiceFromHere). The host takes the replay to the tick and carries on as a
// practice attempt, or leaves the replay playing and says why it can't (another map or style, an older version, a
// gauntlet, a server). This keeps that reason next to the button, as the web viewer's notice does.
//
// The host answers each request with onPracticeFromReplayResult({type:"practiceFromReplayResult", ok, reason}).
// A host that doesn't (an older build), or an answer that never comes, falls back to reading the general error line.

/** Host states to wait for before treating an unchanged error as this request's answer. */
const STALE_STATES = 1;
/** How long to wait for the host's answer before reading the error line instead. */
const ANSWER_WAIT_MS = 2000;
const MAX_REASON_LENGTH = 300;

interface PendingRequest {
  replayId: string;
  errorBefore: string;
  statesSeen: number;
  sentAt: number;
}

export interface PracticeFromReplayResult {
  ok: boolean;
  reason: string | null;
}

/** The host's answer, checked; null when it isn't one. */
export function readPracticeResult(value: unknown): PracticeFromReplayResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (result.type !== "practiceFromReplayResult" || typeof result.ok !== "boolean") return null;
  const reason = typeof result.reason === "string" ? result.reason.trim().slice(0, MAX_REASON_LENGTH) : "";
  return { ok: result.ok, reason: reason || null };
}

export class ReplayPractice {
  private pending: PendingRequest | null = null;
  private reason = "";
  private reasonReplayId = "";
  /** The host has answered a request this session, so its error line isn't read as an answer. */
  private hostAnswers = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly post: typeof send = send,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** `tick` is an absolute recording tick; without it the host uses the tick it is showing. */
  request(tick?: number): void {
    this.reason = "";
    this.pending = { replayId: state.playback.id, errorBefore: state.error ?? "", statesSeen: 0, sentAt: this.now() };
    this.post(tick === undefined ? { type: "practiceFromReplay" } : { type: "practiceFromReplay", tick });
  }

  /** The host's answer to the last request. */
  receive(value: unknown): void {
    const result = readPracticeResult(value);
    if (!result) return;
    this.hostAnswers = true;
    const replayId = this.pending?.replayId ?? state.playback.id;
    this.pending = null;
    this.reason = result.ok ? "" : (result.reason ?? "Practice from here isn't available for this replay.");
    this.reasonReplayId = replayId;
    for (const listener of this.listeners) listener();
  }

  /** Called when an answer arrives; returns the unsubscribe. */
  onAnswer(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    if (this.hostAnswers && this.now() - pending.sentAt < ANSWER_WAIT_MS) return;
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
