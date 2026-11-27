// The Practice line under the crosshair and the yellow timer (hud.ts drawPractice): your own attempt's, or while you
// spectate someone in a room, theirs (0.0.44, hena's "Timer" report: a practising player's timer showed plain white).
// DOM-free (test/spectate-hud.test.ts).

import { styleAt } from "../net/protocol";
import { isSegmented } from "../styles";

/** What the line shows: `label` (null: hidden), the quiet Segmented look, a warning line, and the yellow timer. */
export interface PracticeLine {
  label: string | null;
  segmented: boolean;
  warn: string | null;
  yellow: boolean;
}

/**
 * Your attempt's line (session.ts setPractice), or the watched player's: their practice attempt says Practice with the
 * yellow timer, a Segmented run says Segmented (the room doesn't send their load count), anything else nothing. Your
 * own warning line never shows over theirs.
 */
export function practiceLine(own: { label: string | null; segmented: boolean; warn: string | null }, watched: { practice?: boolean; segmented?: boolean } | null): PracticeLine {
  if (!watched) return { ...own, yellow: !!own.label && !own.segmented };
  const segmented = !watched.practice && !!watched.segmented;
  const label = watched.practice ? "Practice" : segmented ? "Segmented" : null;
  return { label, segmented, warn: null, yellow: !!watched.practice };
}

/** A room player's practice / Segmented state, from the roster (`practice`, their style) and their latest meta's style. */
export function watchedPractice(p: { info: { practice?: boolean; style: string }; meta: { style: number } | null }): { practice: boolean; segmented: boolean } {
  return { practice: !!p.info.practice, segmented: isSegmented(styleAt(p.meta?.style ?? -1) ?? p.info.style) };
}
