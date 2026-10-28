// Only primary server replays get trackers. Pauses preserve progress; seeking resets it.
export class ReplayWatchCount {
  private seconds = 0;
  private sent = false;
  private token: string | null = null;
  constructor(private threshold: number, private send: (token:string)=>Promise<unknown>) {}
  ready(token: string | null): void {this.token=token;}
  seek(): void {if (!this.sent) this.seconds=0;}
  advance(realSeconds:number, replaySeconds:number, eligible:boolean): void {
    if (this.sent || !this.token || !eligible || realSeconds<=0 || replaySeconds<=0) return;
    this.seconds += Math.min(realSeconds,replaySeconds);
    if (this.seconds+1e-6 < this.threshold || !this.token) return;
    this.sent=true;
    void this.send(this.token).catch(()=>{});
  }
}
export const replayWatchThreshold = (duration:number) => Math.min(5, Math.max(0.001,duration*0.9));
