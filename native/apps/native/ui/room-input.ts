// The watched player's HUD feed between the game and the room (web net/spectate-input.ts, protocol.ts input block).
// The game sends its block as JSON with a state batch (spectate_input.hpp to_json); the website's encoder writes the
// bytes. Snapshots' EXT_INPUT blocks come back decoded by the website's decoder and go to the game as JSON.
import {
  encodeInput,
  inputShapeOk,
  IR_SSJ_EVERY,
  IR_SSJ_SIXTH,
  IR_START_PRE,
  MAX_INPUT_REPORTS,
  MAX_INPUT_TICKS,
  type NetInput,
  type NetInputReport,
  type NetInputTick,
  type Snapshot,
} from "../../web/src/net/protocol";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const tickNumber = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const nullableNumber = (value: unknown): boolean => value === null || finite(value);

const SSJ_FIELDS = ["diff", "height", "gain", "sync", "eff", "strafes", "time", "jss"] as const;

function tickValid(t: NetInputTick): boolean {
  return (
    !!t &&
    tickNumber(t.tick) &&
    [t.keys, t.forward, t.side, t.gain, t.state, t.yaw, t.vx, t.vy].every(finite) &&
    (t.turnYaw === undefined || typeof t.turnYaw === "number")
  );
}

function reportValid(r: NetInputReport): boolean {
  if (!r || !tickNumber(r.tick)) return false;
  if (r.kind === IR_START_PRE) return nullableNumber(r.speed);
  if (r.kind !== IR_SSJ_EVERY && r.kind !== IR_SSJ_SIXTH) return false;
  const ssj = r.ssj;
  return !!ssj && finite(ssj.jump) && finite(ssj.speed) && SSJ_FIELDS.every((field) => nullableNumber(ssj[field]));
}

/** The game's block for a state batch, if it is one the website's encoder writes whole, else null. */
export function poseInput(value: unknown): NetInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as NetInput;
  if (![input.tickInterval, input.maxSpeed, input.airAccelerate].every(finite) || input.tickInterval <= 0) return null;
  const { ticks, reports } = input;
  if (!Array.isArray(ticks) || ticks.length < 1 || ticks.length > MAX_INPUT_TICKS) return null;
  if (!Array.isArray(reports) || reports.length > MAX_INPUT_REPORTS) return null;
  if (!ticks.every(tickValid) || !reports.every(reportValid)) return null;
  // Records are consecutive net ticks: the encoder numbers them from the first.
  if (!ticks.every((t, i) => t.tick === ticks[0].tick + i)) return null;
  try {
    return inputShapeOk(encodeInput(input)) ? input : null;
  } catch {
    return null;
  }
}

/** A decoded snapshot's input blocks look like the decoder's (the game checks each field again). */
export function snapshotInputsValid(inputs: Snapshot["inputs"]): boolean {
  return (
    inputs === undefined ||
    (Array.isArray(inputs) &&
      inputs.length <= 64 &&
      inputs.every(
        (entry) => !!entry && tickNumber(entry.slot) && entry.slot <= 255 && poseInput(entry.input) !== null,
      ))
  );
}
