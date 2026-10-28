// Native-only preview transport. The menu never creates a WebGL context or loads the web game.
import type { PlayerGlow } from "../../web/src/player/glow-config";
export interface OnboardingPose {
  position: number[];
  velocity: number[];
  yaw: number;
  pitch: number;
  crouched: boolean;
  grounded: boolean;
  jumped: boolean;
  acting: {
    chestPitch: number;
    chestYaw: number;
    chestRoll: number;
    headPitch: number;
    headYaw: number;
    headRoll: number;
    earL: number;
    earR: number;
  };
  squash: number;
  spin: number;
  clock: number;
}
export interface PreviewRequest {
  loadout: string;
  outfit: string;
  ghost: string;
  playerGlow: PlayerGlow | null;
  view: "fp" | "close" | "bunny" | "ghost" | "onboarding";
  stage?: OnboardingPose;
  yaw: number;
  pitch: number;
  inspect: number;
  held: boolean;
  width: number;
  height: number;
}
type PreviewWindow = Window & { bunnyhopNativeLoadoutPreview?: (frame: { id: number; png: string }) => void };
let serial = 0;
const pending = new Map<number, { done: (png: string) => void; timer: ReturnType<typeof setTimeout> }>();
export function nativePreviewAvailable(): boolean {
  return !!window.webkit?.messageHandlers?.bunnyhop;
}
export function cancelPreview(id: number): void {
  const job = pending.get(id);
  if (job) clearTimeout(job.timer);
  pending.delete(id);
}
export function requestPreview(request: PreviewRequest, done: (png: string) => void): number {
  const host = window.webkit?.messageHandlers?.bunnyhop;
  if (!host) return 0;
  (window as PreviewWindow).bunnyhopNativeLoadoutPreview = (frame) => {
    const job = pending.get(frame.id);
    if (!job) return;
    cancelPreview(frame.id);
    job.done(typeof frame.png === "string" && frame.png.startsWith("data:image/png;base64,") ? frame.png : "");
  };
  const id = ++serial;
  pending.set(id, {
    done,
    timer: setTimeout(() => {
      cancelPreview(id);
      done("");
    }, 3000),
  });
  host.postMessage(JSON.stringify({ type: "loadoutPreview", id, ...request }));
  return id;
}
