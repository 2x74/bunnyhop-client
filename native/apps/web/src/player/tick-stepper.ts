// Replay presentation on the simulation's clock, for every player model that plays a recording (the replay viewer and
// head to head: viewer/player.ts replayTicks; ghosts: ghost.ts). Presentation only: nothing here reaches the simulation.
import type { PlayerPose } from "./pose";

/** A model the TickStepper drives (PlayerModel). */
export interface TickedModel {
  setState(p: PlayerPose): void;
  update(dt: number): void;
  snap(): void;
  preroll(poseAgo: (secondsAgo: number) => PlayerPose | null, seconds?: number): void;
  present(a: number, hold?: boolean): void;
}

/** A recording for the TickStepper: its tick interval and the pose at each whole tick. */
export interface TickSource {
  interval: number;
  /** Last tick. */
  n: number;
  /** The pose at whole tick k (its own ground flag, no events). */
  poseAt(k: number): PlayerPose;
  /** Pre-roll poses ending at tick k (PlayerModel.preroll), stopping at a teleport. */
  prerollTo(k: number): (secondsAgo: number) => PlayerPose | null;
  /** Tick k teleported (no blending into it). */
  teleported(k: number): boolean;
}

/**
 * One frame's events for the model: a carrot swing or an inspect (kept until the model's next tick if this frame has
 * none), and whether an inspect is held (every tick this frame steps).
 */
export type TickEvents = Pick<PlayerPose, "attack" | "inspect" | "inspectHeld">;

/**
 * Replay presentation on the simulation's clock: the model updates once per tick, on that tick's exact pose (its own
 * ground flag, so a bhop's one-tick contact, a landing and a jump happen at the same replay time whatever the playback
 * speed or frame rate), and each frame blends between the last two ticks (PlayerModel.present). Showing display tick t
 * keeps the model at tick ceil(t) and shows it (t - ceil(t) + 1) of the way from the tick before. A cut (seek, first
 * frame, a jump of more than 30 ticks, going backwards) pre-rolls into the tick before and steps one tick.
 */
export class TickStepper {
  /** The tick the model has been updated to (-1: none yet). */
  tick = -1;
  private pending: { attack: number; inspect: number } | null = null;

  reset(): void {
    this.tick = -1;
    this.pending = null;
  }

  show(model: TickedModel, src: TickSource, t: number, cut: boolean, events?: TickEvents): void {
    const target = Math.max(1, Math.min(src.n, Math.ceil(t - 1e-9)));
    if (events && (events.attack || events.inspect)) this.pending = { attack: events.attack ?? 0, inspect: events.inspect ?? 0 };
    const held = !!events?.inspectHeld;
    if (cut || this.tick < 0 || target < this.tick || target - this.tick > 30) {
      const k0 = target - 1;
      model.preroll(src.prerollTo(k0));
      model.setState(src.poseAt(k0));
      model.update(1 / 60);
      this.tick = k0;
      this.pending = null;
    }
    while (this.tick < target) {
      const k = ++this.tick;
      let p = src.poseAt(k);
      if (held) p = { ...p, inspectHeld: true };
      if (this.pending && k === target) {
        p = { ...p, ...this.pending };
        this.pending = null;
      }
      if (src.teleported(k)) model.snap();
      model.setState(p);
      model.update(src.interval);
    }
    model.present(t - (target - 1), src.teleported(target));
  }
}
