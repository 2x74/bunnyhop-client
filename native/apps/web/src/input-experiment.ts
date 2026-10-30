/** Local diagnostic integration, deliberately unrelated to the ranked replay protocol. */
import type { Input, UserCmd } from './input';
import type { SampledInput, SamplerPolicy } from './input-sampler';
import { IN_GIVE_SHIFT, IN_WEAPON_COMMAND_MASK } from './weapon-rules';

export function localInputExperimentAllowed(dev: boolean, hostname: string): boolean {
  return dev && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}
export interface ExperimentContext { multiplayer: boolean; tutorial: boolean; practice: boolean; editor: boolean; queue?: boolean; gauntlet?: boolean; nullBinds?: boolean; wRelease?: boolean; thirdPerson?: boolean; debug?: boolean; autoRestart?: boolean; tickInterval?: number }
export function experimentRejection(c: ExperimentContext): string | null {
  if (c.tickInterval !== undefined && Math.fround(c.tickInterval) !== Math.fround(.01)) return 'Only 100 Hz is supported by the input experiment';
  if (c.queue) return 'Queue mode is unsupported by the input experiment';
  if (c.gauntlet) return 'Gauntlet mode is unsupported by the input experiment';
  if (c.thirdPerson) return 'Third person is unsupported by the input experiment';
  if (c.debug) return 'Debug/scripted play is unsupported by the input experiment';
  if (c.wRelease) return 'Release W on jump is unsupported by the input experiment';
  if (c.autoRestart) return 'Auto restart is unsupported by the input experiment';
  if (c.multiplayer) return 'Multiplayer is unsupported by the input experiment';
  if (c.tutorial) return 'Tutorial is unsupported by the input experiment';
  if (c.practice) return 'Practice mode / noclip is unsupported by the input experiment';
  if (c.editor) return 'Zone editing is unsupported by the input experiment';
  return null;
}

/** Only the weapons host receives this facade. Normal requests still go through Input's timestamped queue.
 * Kept weapons are generated synchronously for EACH physics command (not enqueued at pump wall time,
 * which would delay them past already-due boundaries). The generated request is recorded separately. */
export class ExperimentWeapons {
  private generating = false;
  private give = 0;
  readonly input: Input;
  constructor(input: Input) {
    this.input = new Proxy(input, { get: (target, key) => {
      if (key === 'requestGive') return (id: number) => {
        if (this.generating) this.give = id;
        else target.requestGive(id);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  beforeCommand(command: Readonly<UserCmd>, before: () => void): { command: UserCmd; generatedGive: number } {
    this.give = 0;
    this.generating = true;
    try { before(); } finally { this.generating = false; }
    const generatedGive = this.give;
    return { command: generatedGive ? { ...command, buttons: ((command.buttons & ~IN_WEAPON_COMMAND_MASK) |
      ((generatedGive << IN_GIVE_SHIFT) & IN_WEAPON_COMMAND_MASK)) >>> 0 } : { ...command }, generatedGive };
  }
}

/** Byte bounded JSON records; explicit start/stop, no network or automatic persistence.
 * Freeze through JSON copies as commands can contain mutable integration objects. Sidecars keep their original
 * sampler session/epoch/delivery ids. Truncation is explicit: stop capture rather than silently evict provenance. */
export class InputExperimentCapture {
  private records: Readonly<object>[] = [];
  private bytes = 0;
  private running = false;
  private truncated = false;
  constructor(readonly maxBytes = 8 * 1024 * 1024) {}
  start(metadata: object): void {
    this.records = []; this.bytes = 0; this.truncated = false; this.running = true;
    this.record('metadata', metadata);
  }
  stop(): void { this.running = false; }
  record(kind: string, value: object): void {
    if (!this.running) return;
    const json = JSON.stringify({ kind, value });
    const bytes = new TextEncoder().encode(json).length;
    if (this.bytes + bytes > this.maxBytes) { this.truncated = true; this.running = false; return; }
    const freeze = (v: any): any => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
    this.records.push(freeze(JSON.parse(json))); this.bytes += bytes;
  }
  get state() { return { running: this.running, truncated: this.truncated, bytes: this.bytes, records: this.records.length }; }
  export(): string {
    return JSON.stringify({ format: 'bunnyhop-input-experiment', version: 1, replayCompatible: false,
      unranked: true, ...this.state, records: this.records });
  }
}

/** The sampler is the ONLY accumulator here. A physics callback rebases the view; a lifecycle reset cancels the batch.
 * Render current position (alpha=1), avoiding a second clock/remainder and interpolation across a reset.
 * Camera uses immediate Input preview; the sim only receives the committed command. */
export function pumpInputExperiment(input: Input, apply: (sample: SampledInput) => void, policy: SamplerPolicy = {}): void {
  input.pumpSampler(performance.now(), apply, policy);
}

import { LocalInputEvidence } from './input-evidence';
import type { PlayerState } from './core';
import type { ReplayHeader } from './replay';
import type { SamplerEvidence } from './input-sampler';

export interface LiveApplication {
  sample: SampledInput;
  applied: UserCmd;
  generatedGive: number;
  chatSuppressed: boolean;
  pre: PlayerState;
  post: PlayerState;
  events: number;
  startTick: number;
  endTick: number;
}
export interface LiveCaptureMetadata {
  header: Omit<ReplayHeader, 'version' | 'totalTicks' | 'checkpointInterval'>;
  initial: PlayerState;
  wasmSha256: string;
  explicitRestart: true;
}
/** Separate from diagnostic v1 and protocol3 itself: this envelope is imported OFFLINE to produce
 * two bound BHR streams + protocol3 evidence. No recorder/session persistence is involved.
 * Attach before enable, and detach at the real stop barrier. Never retain an idle sampler history. */
export class LiveInputCapture {
  private evidence = new LocalInputEvidence();
  private metadata?: LiveCaptureMetadata;
  private applications: LiveApplication[] = [];
  private coordinates: { event: number; command: number; state: PlayerState }[] = [];
  private bytes = 0;
  private running = false;
  private failure: string | null = null;
  private inPump = false;
  private stopping = false;
  private input?: Input;
  constructor(readonly maxApplicationBytes = 4 * 1024 * 1024, readonly maxEvidenceBytes = 8 * 1024 * 1024) {}
  start(input: Input, metadata: LiveCaptureMetadata, state: () => PlayerState): void {
    if (this.running || this.stopping || input.samplerState) throw new Error('Capture must attach before sampler enable');
    if (metadata.initial.tick !== 0 || metadata.explicitRestart !== true) throw new Error('Capture requires explicit restart at tick zero');
    this.metadata = JSON.parse(JSON.stringify(metadata));
    this.applications = []; this.coordinates = []; this.bytes = 0; this.failure = null;
    this.evidence = new LocalInputEvidence(this.maxEvidenceBytes, 100000);
    this.input = input; this.running = true; this.inPump = this.stopping = false;
    input.onSamplerEvidence = (event: SamplerEvidence) => {
      if (!this.running && !this.stopping) return;
      try {
        if (event.type === 'pump') this.inPump = true;
        const index = this.evidence.status.events;
        this.evidence.sink(event);
        if (event.type === 'reset' || event.type === 'rebase') this.retain(this.coordinates, { event:index, command:this.applications.length, state:state() });
        if (this.evidence.status.truncated) this.fail('Evidence budget exceeded');
        if (event.type === 'pump-end') { this.inPump = false; if (this.stopping) this.detach(); }
      } catch { this.fail('Capture sink failed'); }
    };
  }
  private retain<T>(target: T[], value: T): void {
    if (!this.running) return;
    const json = JSON.stringify(value), bytes = new TextEncoder().encode(json).length;
    if (this.bytes + bytes > this.maxApplicationBytes || this.applications.length >= 10000) {
      this.fail('Application budget exceeded'); return;
    }
    target.push(JSON.parse(json)); this.bytes += bytes;
  }
  applied(row: LiveApplication): void { this.retain(this.applications, row); }
  fail(reason: string): void { this.failure = reason; this.detach(); }
  private detach(): void { this.running = this.stopping = false; if (this.input) this.input.onSamplerEvidence = null; }
  stop(): void {
    if (!this.running) return;
    // Real cancellation barrier, not an invented frame/callback to drain pending input.
    this.input!.resetSampler(performance.now(), 'live-capture-stop', true);
    // Stopping from sequential apply cancels catch-up, but the genuine pump-end must still be captured.
    if (this.inPump && !this.failure) { this.running = false; this.stopping = true; }
    else this.detach();
  }
  clear(): void {
    this.detach(); this.inPump = false; this.metadata = undefined; this.applications = []; this.coordinates = [];
    this.bytes = 0; this.failure = null; this.evidence = new LocalInputEvidence(this.maxEvidenceBytes, 100000);
  }
  get status() { return { running:this.running, stopping:this.stopping, failure:this.failure, commands:this.applications.length,
    applicationBytes:this.bytes, evidence:this.evidence.status }; }
  export(): string {
    if (this.running || this.stopping) throw new Error('Stop capture at a complete pump boundary before export');
    if (!this.metadata || this.failure) throw new Error(this.failure ?? 'No live capture');
    return JSON.stringify({ schema:'bunnyhop-local-live-input/2', unranked:true, replayCompatible:false,
      metadata:this.metadata, events:this.evidence.snapshot(), applications:this.applications, coordinates:this.coordinates });
  }
}
