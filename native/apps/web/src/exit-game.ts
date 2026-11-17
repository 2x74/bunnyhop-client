// Exit game: the main menu's last entry and a pause menu row, only inside the desktop app (client-bridge.ts), where
// fullscreen leaves no tab or window frame to close. A browser tab never shows it.
//
// Leaving: with a timed run going (the pause menu), one question first, since the run would be lost. Then the page
// lets go of its "Leave site?" guard (play-lock.ts allowLeave), gives a run that is being stored or uploaded right now a
// moment to finish (holdExitFor, at most EXIT_WAIT_MS), and asks the app to quit:
//  - its quit() when it has one (app releases after 0.2.5): the app closes the window, so the page unloads as on any
//    window close, and waits for the requests that unload sent (presence leave, play time) before it quits;
//  - else window.close(). App 0.2.5 and earlier quit as soon as their last window closes, on every system, and so cut
//    off what the page sends while unloading. So first the pagehide work runs here (a pagehide event: the presence
//    leave beacon, play time, first-play, the local counters; each copes with the real one that follows) and gets
//    FLUSH_MS to leave the machine.
//
// DOM-free apart from the defaults (window.close, the pagehide event); menu.ts wires the dialog and the guard.

import { nativeClient, type BunnyhopClient } from "./client-bridge";

/** The longest the exit waits for a run being stored or uploaded. */
export const EXIT_WAIT_MS = 1500;
/** An app without quit(): how long the beacons get before window.close(). */
export const FLUSH_MS = 400;

/** Shown only inside the desktop app. */
export function exitGameShown(native: BunnyhopClient | null = nativeClient()): boolean {
  return !!native;
}

const pending = new Set<Promise<unknown>>();

/** Work an exit should let finish first (a run being stored or uploaded). Returns the same promise. */
export function holdExitFor<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const done = () => void pending.delete(work);
  work.then(done, done);
  return work;
}

/** Waits until nothing is held (checked again after a task, so work handed on from one hold to the next counts), or `ms`. */
export async function settleHeld(ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    const left = end - Date.now();
    if (!pending.size || left <= 0) return;
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, left))]);
  }
}

export interface ExitIO {
  native?: BunnyhopClient | null;
  /** A timed run is going (it would be lost). */
  runInProgress?: () => boolean;
  /** The one question; true to exit. */
  confirm: () => Promise<boolean>;
  /** Drops the page's leave guard. */
  allowLeave: () => void;
  /** The fallback for an app without quit(): runs the page's pagehide work, then closes the window. */
  flush?: () => void;
  close?: () => void;
  waitMs?: number;
  flushMs?: number;
}

/** Exits the desktop app. False when there is no app or the player said no. */
export async function exitGame(io: ExitIO): Promise<boolean> {
  const native = io.native === undefined ? nativeClient() : io.native;
  if (!native) return false;
  if (io.runInProgress?.() && !(await io.confirm())) return false;
  io.allowLeave();
  await settleHeld(io.waitMs ?? EXIT_WAIT_MS);
  if (typeof native.quit === "function") {
    try {
      await native.quit();
      return true;
    } catch {
      /* refused or gone: close the window instead */
    }
  }
  try {
    (io.flush ?? (() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }))))();
  } catch {
    /* a handler threw: close all the same */
  }
  await new Promise((r) => setTimeout(r, io.flushMs ?? FLUSH_MS));
  (io.close ?? (() => window.close()))();
  return true;
}
