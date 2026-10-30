// The video export queue the host runs in its own process (src/video_queue.hpp): every export with its progress, and
// the codecs this computer's FFmpeg can encode. The export dialog and the Replays screen both show the panel.
//
// Host contract (state, under "videoExport"):
//   queue: VideoJob[]          oldest first; finished ones stay until cleared
//   codecs: VideoCodecInfo[]   per codec, the software and hardware encoder FFmpeg has ("" when none)
// Menu messages: {type:"videoExport", action:"cancel", id?} and {type:"videoExport", action:"clear"}.

import { h } from "../../web/src/ui/dom";
import { send } from "./bridge";

export const VIDEO_CODECS = ["h264", "hevc", "av1", "prores", "dnxhr", "ffv1", "png"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];
const JOB_STATES = ["queued", "loading", "rendering", "encoding", "completed", "error", "canceled"] as const;
type JobState = (typeof JOB_STATES)[number];
const MAX_JOBS = 64;
const TEXT_LIMIT = 4096;

export interface VideoJob {
  id: number;
  title: string;
  state: JobState;
  frame: number;
  frames: number;
  /** Seconds left; negative while unknown. */
  eta: number;
  fps: number;
  path: string;
  bytes: number;
  error: string;
  encoder: string;
  hardware: boolean;
  /** Why the encoder isn't the one asked for. */
  note: string;
  elapsed: number;
  seconds: number;
}

export interface VideoCodecInfo {
  id: VideoCodec;
  label: string;
  software: string;
  hardware: string;
}

const host: { jobs: VideoJob[]; codecs: VideoCodecInfo[] } = { jobs: [], codecs: [] };

const text = (value: unknown): string => (typeof value === "string" ? value.slice(0, TEXT_LIMIT) : "");
const count = (value: unknown): number => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0);
const real = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function readJob(value: unknown): VideoJob | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Record<string, unknown>;
  if (!Number.isSafeInteger(job.id) || !JOB_STATES.includes(job.state as JobState)) return null;
  return {
    id: Number(job.id),
    title: text(job.title),
    state: job.state as JobState,
    frame: count(job.frame),
    frames: count(job.frames),
    eta: real(job.eta, -1),
    fps: Math.max(0, real(job.fps, 0)),
    path: text(job.path),
    bytes: count(job.bytes),
    error: text(job.error),
    encoder: text(job.encoder),
    hardware: job.hardware === true,
    note: text(job.note),
    elapsed: Math.max(0, real(job.elapsed, 0)),
    seconds: Math.max(0, real(job.seconds, 0)),
  };
}

function readCodec(value: unknown): VideoCodecInfo | null {
  if (!value || typeof value !== "object") return null;
  const codec = value as Record<string, unknown>;
  if (!VIDEO_CODECS.includes(codec.id as VideoCodec)) return null;
  return {
    id: codec.id as VideoCodec,
    label: text(codec.label),
    software: text(codec.software),
    hardware: text(codec.hardware),
  };
}

/** Reads the queue from a host state message (the same one bridge.ts applies). */
export function applyVideoQueueState(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const video = (value as Record<string, unknown>).videoExport;
  if (!video || typeof video !== "object") return;
  const fields = video as Record<string, unknown>;
  if (Array.isArray(fields.queue)) host.jobs = fields.queue.slice(-MAX_JOBS).flatMap((job) => readJob(job) ?? []);
  if (Array.isArray(fields.codecs))
    host.codecs = fields.codecs.slice(0, VIDEO_CODECS.length).flatMap((codec) => readCodec(codec) ?? []);
}

export const videoJobs = (): readonly VideoJob[] => host.jobs;
export const videoCodecs = (): readonly VideoCodecInfo[] => host.codecs;
export const jobRunning = (job: VideoJob): boolean =>
  job.state === "queued" || job.state === "loading" || job.state === "rendering" || job.state === "encoding";

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function megabytes(bytes: number): string {
  const value = bytes / 1048576;
  return `${value.toFixed(value < 10 ? 1 : 0)} MB`;
}

function encoderLabel(job: VideoJob): string {
  if (!job.encoder) return "";
  return `${job.encoder} (${job.hardware ? "hardware" : "software"})`;
}

/** One line for a job: where it is, how far, and what's left. */
export function jobLine(job: VideoJob): string {
  const percent = job.frames ? Math.round((job.frame / job.frames) * 100) : 0;
  switch (job.state) {
    case "queued":
      return "Waiting";
    case "loading":
      return "Loading the map and replay…";
    case "rendering": {
      const left = job.eta >= 0 ? `${clock(job.eta)} left` : "estimating…";
      const rate = job.fps ? ` · ${Math.round(job.fps)} fps` : "";
      return `Frame ${job.frame} / ${job.frames} · ${percent}% · ${left}${rate}`;
    }
    case "encoding":
      return "Finishing the file…";
    case "completed": {
      const speed = job.elapsed && job.seconds ? ` · ${(job.seconds / job.elapsed).toFixed(1)}× real time` : "";
      return `Saved ${job.path} · ${megabytes(job.bytes)} · ${clock(job.elapsed)} to render${speed}`;
    }
    case "canceled":
      return "Canceled";
    case "error":
      return job.error || "The export failed.";
  }
}

/** The queue as rows with Cancel, and Clear for finished ones. */
export class VideoQueuePanel {
  readonly el = h("div.native-video-queue", { hidden: true });
  private key = "";

  refresh(): void {
    const jobs = videoJobs();
    const key = JSON.stringify(jobs);
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = jobs.length === 0;
    const finished = jobs.some((job) => !jobRunning(job));
    const clear = h(
      "button.link-btn",
      { type: "button", onclick: () => send({ type: "videoExport", action: "clear" }) },
      "Clear finished",
    );
    const heading = h("div.native-video-queue-head", null, h("strong", null, "Video exports"), finished ? clear : null);
    this.el.replaceChildren(heading, ...[...jobs].reverse().map((job) => this.row(job)));
  }

  private row(job: VideoJob): HTMLElement {
    const fill = h("div.rv-ex-fill");
    const done = job.state === "completed" ? 1 : job.frames ? job.frame / job.frames : 0;
    fill.style.transform = `scaleX(${done})`;
    const cancel = jobRunning(job)
      ? h(
          "button.link-btn",
          { type: "button", onclick: () => send({ type: "videoExport", action: "cancel", id: job.id }) },
          "Cancel",
        )
      : null;
    const detail = [encoderLabel(job), job.note].filter(Boolean).join(" · ");
    return h(
      `div.native-video-job.is-${job.state}`,
      null,
      h("div.native-video-job-top", null, h("span", null, job.title), cancel),
      jobRunning(job) ? h("div.rv-ex-bar", null, fill) : null,
      h("small", { role: "status" }, jobLine(job)),
      detail ? h("small.dim", null, detail) : null,
    );
  }
}
