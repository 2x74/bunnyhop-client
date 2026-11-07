// DOM-free client lifecycle. Native port contract: research/ROOM-RACE.md.
import type { RoomRaceView } from "./protocol";
import type { StyleId } from "../styles";
import type { RunBoard } from "./presence";

/** 1st, 2nd, 3rd, 4th, ... 11th, 12th, 13th, 21st: places as the room's chat lines say them (apps/api rooms/room-race.ts). */
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
export type RoomRaceEvent =
  | { kind: "state"; race: RoomRaceView | null }
  | { kind: "countdown"; race: RoomRaceView; seconds: number }
  | { kind: "go"; race: RoomRaceView }
  | { kind: "finish"; race: RoomRaceView; place: number }
  | { kind: "over"; race: RoomRaceView };
export interface RoomRaceHost {
  selectedStyle(): StyleId;
  setStyle(style: StyleId): Promise<void>;
  restart(track: number): void;
  spectating(): boolean;
  stopSpectating(): void;
  toLocal(time: number): number;
  event(event: RoomRaceEvent): void;
  reply(text: string): void;
}
export class RoomRaceClient {
  race: RoomRaceView | null = null;
  private preparing: string | null = null;
  private prepared: string | null = null;
  private went: string | null = null;
  private needsGo = false;
  private failedFor: string | null = null;
  private seconds = -1;
  private resultUntil = 0;
  constructor(private host: RoomRaceHost) {}
  get participating(): boolean {
    const r = this.race, me = r && r.you >= 0 ? r.racers[r.you] : null;
    return !!r && r.state !== "over" && !!me && !me.finish && !me.dnf;
  }
  get frozen(): boolean { return this.participating && this.failedFor !== this.race!.id && (this.race!.state === "countdown" || this.needsGo); }
  tag(run: RunBoard): string | null {
    const r = this.race, me = r && r.you >= 0 ? r.racers[r.you] : null;
    return r?.state === "live" && this.failedFor !== r.id && me && !me.finish && !me.dnf && run.map === r.map && run.style === r.style && run.track === r.track ? r.id : null;
  }
  onState(r: RoomRaceView | null): void {
    const prev = this.race;
    this.race = r;
    this.host.event({ kind: "state", race: r });
    if (r && r.you >= 0) {
      const me = r.racers[r.you], before = prev?.id === r.id && prev.you >= 0 ? prev.racers[prev.you] : null;
      if (me.place !== null && before?.place == null) this.host.event({ kind: "finish", race: r, place: me.place });
    }
    if (!r || r.you < 0 || r.state === "over" || !this.participating) {
      this.needsGo = false;
      if (r?.state === "over" && r.you >= 0) {
        this.resultUntil = Date.now() + 8000;
        if (prev?.state !== "over") this.host.event({ kind: "over", race: r });
      }
      return;
    }
    if (r.state === "countdown" && this.preparing !== r.id) {
      this.preparing = r.id;
      this.seconds = -1;
      void this.prepare(r);
    }
    if (r.state === "live" && this.failedFor !== r.id && prev?.id === r.id && prev.state === "countdown") {
      this.needsGo = true;
      if (this.prepared === r.id) this.go(r);
    }
  }
  private async prepare(r: RoomRaceView): Promise<void> {
    try {
      if (this.host.spectating()) this.host.stopSpectating();
      if (r.track === 0 && this.host.selectedStyle() !== r.style) await this.host.setStyle(r.style);
      if (this.race?.id !== r.id || !this.participating || (this.race.state !== "countdown" && this.race.state !== "live")) return;
      this.prepared = r.id;
      if (this.needsGo) this.go(this.race);
      else this.host.restart(r.track);
    } catch {
      this.failedFor = r.id;
      this.needsGo = false;
      this.host.reply("Couldn't prepare the room race. !leave to withdraw.");
    }
  }
  private go(r: RoomRaceView): void {
    if (this.went === r.id) return;
    this.went = r.id;
    this.needsGo = false;
    if (this.host.spectating()) this.host.stopSpectating();
    this.host.restart(r.track);
    this.host.event({ kind: "go", race: r });
  }
  refresh(now = Date.now()): void {
    const r = this.race;
    if (r?.state === "over" && now > this.resultUntil) { this.race = null; return; }
    if (!r || !this.participating || r.state !== "countdown" || r.goAt === null) return;
    const seconds = Math.max(0, Math.ceil((this.host.toLocal(r.goAt) - now) / 1000));
    if (seconds > 0 && seconds !== this.seconds) {
      this.seconds = seconds;
      this.host.event({ kind: "countdown", race: r, seconds });
    }
    // Zero on a local clock never releases movement; wait for the server's live message.
  }
}
