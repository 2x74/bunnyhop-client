// The microphone for voice chat: asked for on the first push to talk press (never on join), then kept open while you
// stay in the room so the next press starts at once. getUserMedia with the browser's echo cancellation, noise
// suppression and gain control, into the game's AudioContext through a tiny worklet (mic-worklet.js) that hands back
// 20 ms chunks; those are resampled to 48 kHz here and go to the encoder. Nothing is recorded or kept: each chunk is
// encoded and dropped.

import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from "../net/voice-wire";
import { resample } from "./codec";
import workletUrl from "./mic-worklet.js?url&no-inline";

export type MicProblem = "blocked" | "missing" | "unsupported" | "failed";

const loaded = new WeakSet<BaseAudioContext>();

export class MicCapture {
  /** Latest input RMS (linear), ~20 times a second. */
  rms = 0;
  onFrame: (pcm48k: Float32Array) => void = () => {};
  onLevel: (rms: number) => void = () => {};
  private sending = false;

  private constructor(
    private stream: MediaStream,
    private src: MediaStreamAudioSourceNode,
    private node: AudioWorkletNode,
    private sink: GainNode,
  ) {
    node.port.onmessage = (e: MessageEvent<{ pcm?: Float32Array; rate?: number; rms?: number }>) => {
      const d = e.data;
      if (typeof d.rms === "number") {
        this.rms = d.rms;
        this.onLevel(d.rms);
      }
      if (d.pcm && this.sending) {
        const pcm = d.rate === VOICE_SAMPLE_RATE ? d.pcm : resample(d.pcm, d.rate!, VOICE_SAMPLE_RATE);
        this.onFrame(pcm.length === VOICE_FRAME_SAMPLES ? pcm : fit(pcm));
      }
    };
  }

  /** Opens the microphone (`deviceId` "" = the default). Throws a MicProblem string. */
  static async open(ctx: AudioContext, deviceId: string): Promise<MicCapture> {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") throw "unsupported" as MicProblem;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      // The chosen device is gone: fall back to the default once.
      if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) return MicCapture.open(ctx, "");
      throw (name === "NotAllowedError" || name === "SecurityError" ? "blocked" : name === "NotFoundError" ? "missing" : "failed") as MicProblem;
    }
    try {
      if (!loaded.has(ctx)) {
        await ctx.audioWorklet.addModule(workletUrl);
        loaded.add(ctx);
      }
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "voice-mic-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      // A worklet only runs while something pulls it: a silent sink to the destination.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(node).connect(sink).connect(ctx.destination);
      return new MicCapture(stream, src, node, sink);
    } catch {
      for (const t of stream.getTracks()) t.stop();
      throw "failed" as MicProblem;
    }
  }

  /** The device in use (settings shows it). */
  get deviceId(): string {
    return this.stream.getAudioTracks()[0]?.getSettings().deviceId ?? "";
  }

  /** Start / stop handing frames out (push to talk). The level keeps coming either way. */
  setSending(on: boolean): void {
    if (on === this.sending) return;
    this.sending = on;
    this.node.port.postMessage({ send: on });
  }

  close(): void {
    this.setSending(false);
    this.node.port.onmessage = null;
    try {
      this.src.disconnect();
      this.node.disconnect();
      this.sink.disconnect();
    } catch {
      /* already gone */
    }
    for (const t of this.stream.getTracks()) t.stop();
  }
}

/** A resampled chunk a sample off 960 (rounding): pad or trim to the frame. */
function fit(pcm: Float32Array): Float32Array {
  const out = new Float32Array(VOICE_FRAME_SAMPLES);
  out.set(pcm.subarray(0, VOICE_FRAME_SAMPLES));
  return out;
}

/** The microphones the browser lists (labels only after permission). */
export async function microphones(): Promise<{ id: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

/** Whether the page may already use the microphone (no prompt): "granted", "denied" or "prompt". */
export async function micPermission(): Promise<"granted" | "denied" | "prompt"> {
  try {
    const s = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return s.state;
  } catch {
    return "prompt";
  }
}
