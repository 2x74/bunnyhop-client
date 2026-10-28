/** Zero-holdback, fixed 100 Hz command sampling. No DOM, physics, replay codec or device-time inference. */
import type { UserCmd } from './input';
import { YAW_SET_TELEPORT, YAW_SET_PUSHER, YAW_SET_SENSITIVITY, YAW_SET_TURN, YAW_WITH_TURN, type LookSample } from './replay';
import { resolveNullBinds } from './null-binds';
import { TURN_BITS, turnDelta } from './turn-binds';

export type SamplerSource = 'pointermove' | 'pointerrawupdate' | 'mousemove';
/**
 * holdbackMs: a command's boundary executes only once the clock is this far past it, so mouse reports stamped just
 * before the boundary have arrived (a report that misses its command lands in the next one: per-tick yaw error, lost
 * gain). Camera preview is unaffected; only physics trails by it. Fixed per sampler session (recorded at enable).
 */
export interface SamplerOptions { source: SamplerSource; origin: number; capacity?: number; maxGapMs?: number; holdbackMs?: number }
/** Per pump: the style's bind policy (main.ts tick()): null binds resolve opposite movement keys to the newest press;
 * turn binds (+left / +right) turn the committed view by cl_yawspeed per command, else their bits are dropped. */
export interface SamplerPolicy { nullBinds?: boolean; turnBinds?: boolean }
export interface SamplerView { base: number; count: number; k: number; epoch: number; kind: number; pitch: number }
export type Payload =
  | { type: 'motion'; x: number; y: number; k: number; pitchK: number; delivery: number; quality: string; report?: number }
  | { type: 'key'; code: string; down: boolean; bits: number }
  | { type: 'pulse'; bits: number }
  | { type: 'slot' | 'give'; value: number };
export interface Consumption {
  readonly seq: number; readonly originalEventTime: number | null; readonly eventTime: number; readonly arrivalTime: number;
  readonly timing: 'event' | 'arrival-only'; readonly committedAtArrival: number; readonly late: boolean; readonly lateMs: number;
  readonly stale: boolean; readonly expired: boolean; readonly payload: Readonly<Payload>;
}
export interface SampledInput {
  readonly command: Readonly<UserCmd>;
  readonly provenance: Readonly<{
    version: 1; session: number; epoch: number; tick: number; boundary: number; executedAt: number;
    collapsedMs: number; records: readonly Readonly<Consumption>[];
  }>;
}
export interface SamplerReset {
  readonly version: 1; readonly session: number; readonly epoch: number; readonly reason: string;
  readonly at: number; readonly records: number; readonly x: number; readonly y: number;
  readonly cancelled: readonly Readonly<RecordEntry>[];
  readonly foldedKeys: readonly Readonly<RecordEntry>[];
}
export interface RecordEntry { seq: number; originalEventTime: number | null; eventTime: number; arrivalTime: number; committedAtArrival: number; late: boolean; timing: 'event' | 'arrival-only'; payload: Readonly<Payload> }
const norm = (v: number) => ((v % 360) + 360) % 360;
const clamp = (v: number) => Math.max(-89, Math.min(89, v));
const DIRECTION = (1 << 3) | (1 << 4) | (1 << 9) | (1 << 10) | (1 << 2) | TURN_BITS;
const finite = (v: number) => { if (!Number.isFinite(v)) throw new Error('Nonfinite sampler value'); return v; };

/** Opt-in local evidence stream. Events contain immutable ingestion-time values, never device attestation. */
export type SamplerEvidence = Readonly<{type: string; [key: string]: unknown}>;
export function evidenceSnapshot<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) evidenceSnapshot(v);
    Object.freeze(value);
  }
  return value;
}
export class InputSampler {
  evidence(event: SamplerEvidence): void { this.sink?.(evidenceSnapshot(event)); }

  readonly source: SamplerSource;
  readonly capacity: number;
  readonly maxGapMs: number;
  readonly holdbackMs: number;
  private queue: RecordEntry[] = [];
  private seq = 0;
  private epoch = 0;
  private tick = 0;
  private origin: number;
  private offset = 0;
  private expiredBefore = -Infinity;
  private lastPump: number;
  private lastArrival: number;
  private committed: number;
  private view: SamplerView;
  /** View epoch the last command carried (a turn in a command that also had a set keeps the set's kind). */
  private sampledEpoch = -1;
  private keys = new Map<string, { bits: number; time: number; seq: number; down: boolean }>();
  private fault = false;
  rejectedEpoch = 0;
  rejectedEpochX = 0;
  rejectedEpochY = 0;
  /** Bounded cancellation ledger: caller may persist the latest barrier alongside its replay sidecar. */
  lastReset: Readonly<SamplerReset>;

  constructor(options: SamplerOptions, view: SamplerView, readonly session = 0, private readonly sink?: (event: SamplerEvidence) => void) {
    for (const key of Object.keys(options)) if (!["source","origin","capacity","maxGapMs","holdbackMs"].includes(key)) throw new Error(`Unsupported sampler option: ${key}`);
    this.source = options.source;
    this.capacity = options.capacity ?? 32768;
    this.maxGapMs = options.maxGapMs ?? 250;
    this.holdbackMs = options.holdbackMs ?? 0;
    if (!['pointermove', 'pointerrawupdate', 'mousemove'].includes(this.source)) throw new Error('Invalid sampler source');
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 1_000_000) throw new Error('Invalid sampler capacity');
    if (!Number.isFinite(this.maxGapMs) || this.maxGapMs < 10 || this.maxGapMs > 250 || this.maxGapMs % 10 !== 0) throw new Error('maxGapMs must be a 10 ms multiple, 10..250');
    if (!Number.isFinite(this.holdbackMs) || this.holdbackMs < 0 || this.holdbackMs > 20) throw new Error('holdbackMs must be 0..20');
    this.origin = this.lastPump = this.lastArrival = this.committed = finite(options.origin);
    for (const value of Object.values(view)) finite(value);
    this.view = { ...view };
    this.lastReset = Object.freeze({version:1, session:this.session, epoch: 0, reason: 'enable', at: options.origin, records: 0, x: 0, y: 0, cancelled:Object.freeze([]), foldedKeys:Object.freeze([])});
    this.evidence({type:'enable', options:{source:this.source,origin:this.origin,capacity:this.capacity,maxGapMs:this.maxGapMs,holdbackMs:this.holdbackMs}, view:{...view}, session});
  }

  get pending(): number { return this.queue.length; }
  get failed(): boolean { return this.fault; }

  /** Committed state is authoritative; release barriers discard pending motion. */
  get committedView(): SamplerView { return { ...this.view }; }
  private fold(view: SamplerView, p: Extract<Payload, {type:'motion'}>): void {
    if (p.k !== view.k) {
      view.base = norm(view.base - view.count * view.k);
      view.count = 0; view.k = p.k; view.epoch++; view.kind = YAW_SET_SENSITIVITY;
    }
    view.count += p.x;
    view.pitch = clamp(view.pitch + p.y * p.pitchK);
  }
  get previewView(): SamplerView {
    const view = this.committedView;
    for (const r of [...this.queue].sort((a,b) => a.eventTime-b.eventTime || a.seq-b.seq)) {
      if (r.payload.type === 'motion') this.fold(view, r.payload);
    }
    return view;
  }
  /** Physics changes the view at the last committed boundary, never the wall clock or input queue. */
  rebase(yaw: number, pitch: number, kind: number): void {
    if (![YAW_SET_TELEPORT, YAW_SET_PUSHER].includes(kind)) throw new Error('Unknown physics view source');
    finite(yaw); finite(pitch);
    if (pitch !== clamp(pitch)) throw new Error('Invalid physics pitch');
    this.view = {...this.view, base:norm(yaw), count:0, pitch, epoch:this.view.epoch+1, kind};
    this.evidence({type:'rebase', source:'physics', boundary:this.committed, tick:this.tick, epoch:this.epoch, view:this.committedView});
  }
  reset(at: number, view: SamplerView, reason: string, preserveHeld = false): void {
    finite(at);
    for (const value of Object.values(view)) finite(value);
    let x = 0, y = 0;
    for (const r of this.queue) if (r.payload.type === 'motion') { x += r.payload.x; y += r.payload.y; }
    const foldedKeys = preserveHeld ? this.queue.filter(r=>r.payload.type==='key').sort((a,b)=>a.eventTime-b.eventTime || a.seq-b.seq) : [];
    const cancelled = preserveHeld ? this.queue.filter(r=>r.payload.type!=='key') : [...this.queue];
    this.lastReset = Object.freeze({version:1, session:this.session, epoch: ++this.epoch, reason, at, records: cancelled.length, x, y,
      cancelled:Object.freeze(cancelled), foldedKeys:Object.freeze(foldedKeys)});
    for (const r of foldedKeys) {
      const p=r.payload;
      if (p.type !== 'key') continue;
      const previous=this.keys.get(p.code);
      if (!previous || r.eventTime>previous.time || (r.eventTime===previous.time && r.seq>previous.seq)) {
        this.keys.set(p.code,{bits:p.bits,down:p.down,time:r.eventTime,seq:r.seq});
      }
    }
    this.queue = []; if (!preserveHeld) this.keys.clear();
    this.tick = 0; this.offset = 0; this.expiredBefore = -Infinity;
    this.origin = this.lastPump = this.lastArrival = this.committed = at;
    this.view = { ...view }; this.fault = false;
    this.evidence({type:'reset', reset:this.lastReset, view:{...view}, preserveHeld, heldDisposition:preserveHeld?'ordered-pending-keys':'released'});
  }

  enqueue(payload: Payload, eventTime: number, arrivalTime: number): boolean {
    if (this.fault) { this.evidence({type:'unavailable', payload:{...payload}, eventTime:Number.isFinite(eventTime)?eventTime:null, arrivalTime}); throw new Error('Sampler overflow: reset required'); }
    finite(arrivalTime);
    if (arrivalTime < this.lastArrival || arrivalTime < this.lastPump) throw new Error('Sampler arrival clock moved backwards');
    this.lastArrival = arrivalTime;
    if (Number.isFinite(eventTime) && eventTime >= 0 && eventTime < this.origin) {
      this.rejectedEpoch++;
      if (payload.type === 'motion') { this.rejectedEpochX += finite(payload.x); this.rejectedEpochY += finite(payload.y); }
      this.evidence({type:'ingest', disposition:'old-epoch', payload:{...payload}, eventTime:Number.isFinite(eventTime)?eventTime:null, arrivalTime});
      return false;
    }
    for (const value of Object.values(payload)) if (typeof value === 'number') finite(value);
    // Foreign/future timestamps use the callback clock; old epoch records were rejected above; never invent a report time or wait indefinitely.
    const valid = Number.isFinite(eventTime) && eventTime >= this.origin && eventTime <= arrivalTime;
    if (this.queue.length >= this.capacity) { this.fault = true; this.evidence({type:'ingest',disposition:'overflow',payload:{...payload},eventTime:Number.isFinite(eventTime)?eventTime:null,arrivalTime}); throw new Error('Sampler overflow: reset required'); }
    this.queue.push(Object.freeze({seq: ++this.seq, originalEventTime:Number.isFinite(eventTime) ? eventTime : null, eventTime: valid ? eventTime : arrivalTime, arrivalTime,
      timing: valid ? 'event' : 'arrival-only', committedAtArrival:this.committed, late:this.tick > 0 && (valid ? eventTime : arrivalTime) <= this.committed, payload: Object.freeze({...payload})}));
    this.evidence({type:'ingest', disposition:'queued', record:this.queue[this.queue.length-1]});
    return true;
  }

  pump(now: number, delivery: Pick<LookSample, 'frames' | 'events' | 'reports'>, apply?: (sample: SampledInput) => void, policy: SamplerPolicy = {}): SampledInput[] {
    finite(now);
    if (this.fault) throw new Error('Sampler overflow: reset required');
    if (now < this.lastPump || now < this.lastArrival) throw new Error('Sampler pump precedes arrival');
    const nullBinds = !!policy.nullBinds, turnBinds = !!policy.turnBinds;
    this.evidence({type:'pump', now, delivery:{...delivery}, policy:{nullBinds, turnBinds}});
    // Preserve the fractional accumulator remainder, discard the oldest excess wall interval.
    const collapsedMs = Math.max(0, now - this.lastPump - this.maxGapMs);
    this.offset += collapsedMs;
    if (collapsedMs > 0) this.expiredBefore = this.origin + this.offset + this.tick * 10;
    this.lastPump = now;
    this.queue.sort((a,b) => a.eventTime - b.eventTime || a.seq - b.seq);
    const result: SampledInput[] = [];
    let cursor = 0;
    for (;;) {
      const boundary = this.origin + this.offset + (this.tick + 1) * 10;
      if (boundary + this.holdbackMs > now) break;
      let pulses = 0, slot = 0, give = 0;
      const records: Readonly<Consumption>[] = [];
      while (cursor < this.queue.length && this.queue[cursor].eventTime <= boundary) {
        const r = this.queue[cursor++], p = r.payload;
        let stale = false;
        // Collapsed history preserves motion and held state, but cannot replay old action edges.
        const expired = p.type !== 'motion' && r.eventTime <= this.expiredBefore;
        if (p.type === 'motion') {
          this.fold(this.view, p);
        } else if (p.type === 'key') {
          const previous = this.keys.get(p.code);
          stale = !!previous && (r.eventTime < previous.time || (r.eventTime === previous.time && r.seq < previous.seq));
          if (!stale) {
            if (!expired && p.down && !previous?.down) pulses |= p.bits & ~DIRECTION;
            this.keys.set(p.code, {bits:p.bits, down:p.down, time:r.eventTime, seq:r.seq});
          }
        } else if (!expired) {
          if (p.type === 'pulse') pulses |= p.bits;
          else if (p.type === 'slot') slot = p.value & 3;
          else give = p.value;
        }
        records.push(Object.freeze({seq:r.seq, originalEventTime:r.originalEventTime, eventTime:r.eventTime, arrivalTime:r.arrivalTime, timing:r.timing,
          committedAtArrival:r.committedAtArrival, late:r.late, lateMs:Math.max(0, r.committedAtArrival - r.eventTime), stale, expired, payload:p}));
      }
      // Held keys in press order (null binds keep the newest of opposite keys; a pulse is this command's press).
      const held = [...this.keys.values()].filter(k => k.down).sort((a,b) => a.time-b.time || a.seq-b.seq).map(k => k.bits);
      let buttons = (nullBinds ? resolveNullBinds([...held, pulses]) : held.reduce((b,k) => b | k, pulses)) | (slot << 14) | (give << 16);
      if (!turnBinds) buttons &= ~TURN_BITS;
      else if ((buttons & TURN_BITS) === TURN_BITS) buttons &= ~TURN_BITS; // opposing turn binds cancel (legacy input.ts)
      else if (buttons & TURN_BITS) {
        this.view.base = norm(this.view.base + turnDelta(buttons, 0.01));
        this.view.kind = this.view.epoch === this.sampledEpoch ? YAW_SET_TURN : this.view.kind | YAW_WITH_TURN;
        this.view.epoch++;
      }
      this.sampledEpoch = this.view.epoch;
      const look = Object.freeze({base:this.view.base, count:this.view.count, k:this.view.k, epoch:this.view.epoch,
        kind:this.view.kind, ...(result.length === 0 ? delivery : {frames:0, events:0, reports:0})});
      const command = Object.freeze({pitch:this.view.pitch, yaw:norm(this.view.base - this.view.count * this.view.k),
        forwardmove:450 * (Number(!!(buttons & 8)) - Number(!!(buttons & 16))),
        sidemove:450 * (Number(!!(buttons & 1024)) - Number(!!(buttons & 512))), buttons, look, ...(nullBinds ? {nullBinds:true} : {})});
      result.push(Object.freeze({command, provenance:Object.freeze({version:1 as const, session:this.session, epoch:this.epoch,
        tick:++this.tick, boundary, executedAt:now, collapsedMs:result.length === 0 ? collapsedMs : 0,
        records:Object.freeze(records)})}));
      this.committed = boundary;
      if (cursor) { this.queue.splice(0,cursor); cursor = 0; }
      // Physics rebases continue the batch; lifecycle resets invalidate its schedule.
      const epoch = this.epoch;
      this.evidence({type:'sample', sample:result[result.length - 1]});
      apply?.(result[result.length - 1]);
      if (this.epoch !== epoch) { this.evidence({type:'pump-end', commands:result.length}); return result; }
    }
    this.evidence({type:'pump-end', commands:result.length});
    return result;
  }
}
