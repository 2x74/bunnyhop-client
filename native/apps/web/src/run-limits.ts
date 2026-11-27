// How long a run can be (owner, 2026-11-19): the leaderboard takes runs up to RANKED_MAX_HOURS; the web game records
// longer ones for the player anyway and only stops at a safety cap for the browser's memory. DOM-free, and the one
// source for the server too (apps/api/src/replay-io.ts MAX_TICKS, apps/api/src/run-clock.ts MAX_BEATS), so the client
// and the server can't disagree about where the line is.
//
//   up to 8 h       ranked as ever: uploaded, verified, on the board.
//   past 8 h        the game says so once (PAST_RANKED_LINE); at the finish nothing is uploaded and the replay is kept
//                   on this device with the practice replays (session.ts finishUnrankable), downloadable from there and
//                   from Esc, Replays, Export last run. The server refuses such a replay as `too_long` (413), which the
//                   upload code treats as final (uploads.ts) and keeps on the device too.
//   RECORDING_CAP   recording stops (session.ts capRecording): what was recorded is kept the same way, and the player is
//                   told. Only for the browser's memory. Measured (2026-11-19, Node/V8 without pointer compression, so
//                   Chrome holds a little less; web-rec-mem in the 8 h report): the recorder's columns and view states
//                   (34 bytes a command), the live frames to 8 h and the Segmented / practice history to 4 h hold
//                   308 MB at 8 h, 372 MB at 12 h, 609 MB at 24 h; building and encoding the replay at the end adds up
//                   to ~240 MB (12 h) / ~470 MB (24 h) for a moment. Before (a view-state object a command, doubling
//                   growth, frames all run) 8 h alone held 698 MB, +280 MB at the end, and nothing stopped a recording.
//                   12 h, not 24 (2026-11-19): ~1.1 GB at a 24 h finish is too much for Chromebooks and small laptops;
//                   the native client, ~76 bytes a command, keeps 24 h.

/** Every run is 100 tick (replay.ts; the server's verifier checks the tick interval). */
const TICKS_PER_HOUR = 3600 * 100;

/** The longest run the leaderboard takes, in hours. */
export const RANKED_MAX_HOURS = 8;
/** ...in recorded commands: a replay with more (its header's totalTicks, from the restart) can't be ranked. */
export const RANKED_MAX_TICKS = RANKED_MAX_HOURS * TICKS_PER_HOUR;

/** Where the browser stops recording a run, in hours (memory; see the header). */
export const RECORDING_CAP_HOURS = 12;
export const RECORDING_CAP_TICKS = RECORDING_CAP_HOURS * TICKS_PER_HOUR;

/**
 * Heartbeat tokens per run, on both sides (apps/web/src/run-clock.ts, apps/api/src/run-clock.ts): beats come every 4 s of
 * wall time while the timer runs, pauses included, so 8 h is 7,200 or more; 15,000 leaves room for pauses (the native
 * client keeps the same count).
 */
export const RUN_MAX_BEATS = 15_000;

/** The server's refusal of a replay over RANKED_MAX_TICKS (apps/api/src/replay-io.ts tooLong): final, never retried. */
export const TOO_LONG_CODE = "too_long";

/** The run's recording is past what the leaderboard takes. */
export const pastRanked = (recordedTicks: number): boolean => recordedTicks > RANKED_MAX_TICKS;

/** Shown once, the tick a running run's recording passes RANKED_MAX_TICKS. */
export const PAST_RANKED_LINE = `Past ${RANKED_MAX_HOURS} hours: this run will be saved to your replays but can't go on the leaderboard.`;
