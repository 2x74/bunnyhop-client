// The Friends panel's "Find a player" (social/dock.ts), without the DOM: typing waits a moment, then asks; a newer query
// cancels the one in flight and only the latest answer is ever shown. Too short a query clears the results.

export type SearchState<T> =
  | { k: "idle" }
  | { k: "loading"; q: string }
  | { k: "done"; q: string; items: T[] }
  | { k: "error"; q: string };

export interface LiveSearch {
  /** The field's text changed. */
  input(text: string): void;
  /** Asks again for the current text (Retry, or after the list behind it changed). */
  again(): void;
  /** Drops anything pending (the panel closed). */
  cancel(): void;
}

export function liveSearch<T>(
  fetch: (q: string, signal: AbortSignal) => Promise<T[]>,
  show: (s: SearchState<T>) => void,
  o: { min?: number; ms?: number; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {},
): LiveSearch {
  const min = o.min ?? 2;
  const ms = o.ms ?? 250;
  const setTimer = o.setTimer ?? ((f, t) => setTimeout(f, t));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as number));
  let timer: unknown = null;
  let ctl: AbortController | null = null;
  let seq = 0;
  let text = "";

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    ctl?.abort();
    ctl = null;
  };
  const run = () => {
    timer = null;
    const q = text.trim();
    const mine = ++seq;
    const c = new AbortController();
    ctl = c;
    show({ k: "loading", q });
    fetch(q, c.signal).then(
      (items) => mine === seq && show({ k: "done", q, items }),
      () => mine === seq && !c.signal.aborted && show({ k: "error", q }),
    );
  };
  return {
    input(t) {
      text = t;
      stop();
      seq++;
      if (t.trim().length < min) return show({ k: "idle" });
      timer = setTimer(run, ms);
    },
    again() {
      if (text.trim().length < min) return;
      stop();
      run();
    },
    cancel() {
      stop();
      seq++;
    },
  };
}
