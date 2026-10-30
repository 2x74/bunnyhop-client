// Polling and frame diagnostics from the vendored website, without DOM or network access.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { InputStats, POLL_RATES, RunPollRate } from "../../apps/web/src/mouse-filter";

const startMs = 1000;
const source = resolve(import.meta.dir, "../../apps/web/src/mouse-filter.ts");
const output = resolve(import.meta.dir, "../../apps/native/src/run_diagnostics_vectors.json");

function scenario(rate: number, durationMs: number, frameMs: number, movingMs = durationMs) {
  const stats = new InputStats();
  const poll = new RunPollRate();
  stats.frame(startMs, startMs);
  let nextReport = 1;
  for (let elapsed = frameMs; elapsed <= durationMs; elapsed += frameMs) {
    while ((nextReport * 1000) / rate <= Math.min(elapsed, movingMs)) {
      const timestamp = startMs + (nextReport++ * 1000) / rate;
      stats.event(timestamp, 3, 3, 0, 1, timestamp);
    }
    stats.frame(startMs + elapsed, startMs + elapsed);
    poll.sample(startMs + elapsed, (now, windowMs) => stats.pollHz(now, windowMs));
  }
  return {
    rate,
    durationMs,
    frameMs,
    movingMs,
    expected: {
      events: stats.events,
      reports: stats.samples,
      maxDelta: stats.maxDelta,
      frameP50: InputStats.pct(stats.frDur, 0.5),
      frameP99: InputStats.pct(stats.frDur, 0.99),
      frameMax: stats.maxFrame,
      over25: stats.framesOver25,
      over50: stats.framesOver50,
      pollHz: poll.hz(),
    },
  };
}

const scenarios = POLL_RATES.map((rate) => scenario(rate, 2000, 10));
scenarios.push(scenario(1000, 1000, 10), scenario(1000, 3000, 40), scenario(1000, 3000, 60));
scenarios.push(scenario(1000, 2000, 10, 200));
writeFileSync(
  output,
  JSON.stringify(
    {
      source: "apps/web/src/mouse-filter.ts",
      sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
      startMs,
      scenarios,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${scenarios.length} run diagnostics vectors -> ${output}`);
