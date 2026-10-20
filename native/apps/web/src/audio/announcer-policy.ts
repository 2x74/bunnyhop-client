// Cosmetic policy only: timer counters and verified run identities are the inputs.
import type { AnnouncerLine, AnnouncerPrefs } from "../ui/settings";
export type AnnouncerEvent = "pb" | "wr" | "speed" | "highSpeed" | "streak";
export class AnnouncerPolicy {
  private seen = new Set<string>();
  private until = 0;
  private priority = 0;
  private movementAt = -Infinity;
  private milestones = new Set<AnnouncerEvent>();
  private streak = 0;
  private streakSaid = false;
  private ground = 0;
  resetAttempt(): void { this.milestones.clear(); this.breakStreak(); }
  breakStreak(): void { this.streak = 0; this.streakSaid = false; this.ground = 0; }
  /** Highest crossed threshold wins, including when thresholds are customized in reverse order. */
  tick(p: AnnouncerPrefs, speed: number, hop: boolean | null, grounded: boolean, dt: number, broken: boolean): AnnouncerEvent | null {
    if (broken) { this.breakStreak(); return null; }
    this.ground = grounded ? this.ground + dt : 0;
    if (this.ground >= 0.1) this.breakStreak();
    if (hop === false) this.breakStreak();
    else if (hop === true) this.streak++;
    const crossed: [AnnouncerEvent, number][] = [["speed", p.speedThreshold], ["highSpeed", p.highSpeedThreshold]];
    const candidates = crossed.filter(([e, n]) => Number.isFinite(n) && n > 0 && speed >= n && !this.milestones.has(e));
    for (const [e] of candidates) this.milestones.add(e);
    candidates.sort((a,b) => b[1] - a[1]);
    const streak = !this.streakSaid && this.streak >= Math.max(2, p.streakThreshold);
    if (streak) this.streakSaid = true;
    return candidates.find(([e]) => p[e] !== "off")?.[0] ?? (streak && p.streak !== "off" ? "streak" : null);
  }
  /** No queue: stale cues are dropped. A verified WR may interrupt anything; PB may interrupt movement. */
  admit(p: AnnouncerPrefs, event: AnnouncerEvent, now: number, duration: number, id?: string, remote = false, preview = false): AnnouncerLine | null {
    const movement = event !== "pb" && event !== "wr";
    if (!preview && id) {
      if (this.seen.has(id)) return null;
      this.seen.add(id);
      if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    }
    if (!preview && (!p.enabled || (movement ? !p.movement : !p.finish) || (remote ? !p.server : !p.local))) return null;
    const line = p[event];
    if (line === "off" || !["perfect", "godlike", "holyshit"].includes(line)) return null;
    const priority = event === "wr" ? 3 : event === "pb" ? 2 : 1;
    if (!preview && ((now < this.until && priority <= this.priority) || (movement && now - this.movementAt < 8))) return null;
    this.priority = priority;
    this.until = now + duration;
    if (movement) this.movementAt = now;
    return line;
  }
}
