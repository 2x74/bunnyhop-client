// One look at the runs kept on this device (uploads.ts holds the rules, online.ts the timers). DOM-free, with everything
// it touches passed in, so apps/web/test/upload-retry.test.ts can play out a refused, waiting and finally accepted run.

import { effectiveFailure, expired, failureOf, failureText, holds, shouldRetry, spendAttempt, type StoredUpload } from "./uploads";
import type { Submission, User } from "./api";

/** More runs than this in one go get a single line, not their own toasts. */
const BACKLOG_TOASTS = 3;

export interface RetryIO {
  me: () => Promise<Pick<User, "id" | "name"> | null>;
  /** The last me() came from memory, not from the server. */
  meStale: () => boolean;
  store: { all: () => Promise<StoredUpload[]>; put: (u: StoredUpload) => Promise<void>; remove: (sha: string) => Promise<void> };
  /** The run is one a gauntlet attempt sends itself. */
  heldElsewhere: (u: StoredUpload) => boolean;
  queueLegacy: (me: Pick<User, "id" | "name">) => Promise<void>;
  send: (u: StoredUpload, me: Pick<User, "id" | "name">) => Promise<Submission>;
  verdict: (sub: Submission) => Promise<Submission>;
  accepted: (id: string) => void;
  rejected: (u: StoredUpload) => void;
  say: (msg: string, ms?: number) => void;
  sayBad: (msg: string) => void;
  label: (u: StoredUpload) => string;
  now: () => number;
}

export interface RetryOutcome {
  /** Runs remain that a later look can send. */
  waiting: boolean;
  /** Some run reached the server. */
  delivered: boolean;
}

/** Sends every stored run due a retry. Throws only if the store or me() does. */
export async function retryStored(io: RetryIO): Promise<RetryOutcome> {
  const me = await io.me();
  const now = io.now();
  const all = await io.store.all();
  for (const u of all) if (expired(u, now)) await io.store.remove(u.sha);
  // Without a session the server would refuse the run or make it a new guest, and a stale `me` is only what this browser
  // remembers. Nothing is sent or used up; me() asks for a session again on the next look.
  if (!me || io.meStale()) {
    return { waiting: all.some((u) => !expired(u, now) && !io.heldElsewhere(u) && shouldRetry(u, u.account, now)), delivered: false };
  }
  await io.queueLegacy(me);
  const due = (await io.store.all()).filter((u) => !expired(u, now) && !io.heldElsewhere(u) && shouldRetry(u, me.id, now)).sort((a, b) => a.at - b.at);
  const quiet = due.length > BACKLOG_TOASTS;
  const result: RetryOutcome = { waiting: false, delivered: false };
  let uploaded = 0;
  for (const stored of due) {
    const wasHeld = holds(effectiveFailure(stored, now));
    const u = spendAttempt(stored, now);
    if (u !== stored) await io.store.put(u);
    let sub: Submission;
    try {
      sub = await io.send(u, me);
    } catch {
      // A run that was waiting keeps waiting; the rest have counted this send.
      if (!wasHeld) await io.store.put({ ...u, state: "failed", failure: "network", at: io.now() });
      if (wasHeld || !u.retried) result.waiting = true;
      else io.sayBad(`Your earlier ${io.label(u)} still hasn't uploaded.`);
      continue;
    }
    const failure = failureOf(sub);
    if (failure && holds(failure)) {
      // The answer every other run here would get too, so they wait together. `at` stays: it's how long this has waited.
      await io.store.put({ ...u, state: "failed", failure, account: failure === "guest_limit" ? null : u.account, at: wasHeld ? u.at : io.now() });
      result.waiting = true;
      break;
    }
    if (failure) {
      await io.store.put({ ...u, state: "failed", failure, at: io.now() });
      io.sayBad(`Your earlier ${io.label(u)} still hasn't uploaded: ${failureText(failure)}.`);
      continue;
    }
    await io.store.remove(u.sha);
    result.delivered = true;
    if (!sub.id) {
      if (sub.status === "rejected") io.rejected(u);
      io.sayBad(`Your earlier ${io.label(u)} wasn't accepted: ${sub.reason ?? "refused"}.`);
      continue;
    }
    io.accepted(sub.id);
    uploaded++;
    if (!quiet) io.say(`Your earlier ${io.label(u)} is uploaded. Checking it now.`, 5000);
    const v = await io.verdict(sub);
    if (v.status === "rejected") {
      io.rejected(u);
      io.sayBad(`Your earlier ${io.label(u)} wasn't accepted: ${v.reason ?? "rejected"}.`);
    } else if (!quiet && v.status === "verified") io.say(`Your earlier ${io.label(u)} is on the board${v.rank ? ` at #${v.rank}` : ""}.`, 8000);
    else if (!quiet && v.status === "error") io.say(`Your earlier ${io.label(u)} is waiting for review.`, 8000);
  }
  if (quiet && uploaded) io.say(`${uploaded} earlier runs uploaded.`, 8000);
  return result;
}
