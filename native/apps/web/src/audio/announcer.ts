import { prefs } from "../ui/settings";
import type { AnnouncerLine } from "../ui/settings";
import { manifest } from "./assets";
import { AnnouncerPolicy, type AnnouncerEvent } from "./announcer-policy";
import { engine, duckMusic } from "./index";
import type { SfxId } from "./catalog";
export const announcerPolicy = new AnnouncerPolicy();
export function announcerAvailable(line: AnnouncerLine): boolean {
  return line !== "off" && !!manifest.sfx[`announcer_${line}`]?.variants;
}
export function announce(event: AnnouncerEvent, id?: string, remote = false, preview: AnnouncerLine | false = false): void {
  const a = prefs.get().audio;
  const line = preview || a.announcer[event];
  if (!announcerAvailable(line) || a.muted || a.mute.sfx || (document.hidden && a.muteInBackground) || prefs.get().volume <= 0 || !engine.unlocked) {
    // Consume muted/unavailable verified results too: reconnecting must not replay them later.
    if (id && !preview) announcerPolicy.admit({ ...a.announcer, enabled: false }, event, 0, 0, id, remote);
    return;
  }
  const duration = Math.max(...(manifest.sfx[`announcer_${line}`]?.durations ?? [2]));
  const admitted = announcerPolicy.admit(preview ? { ...a.announcer, [event]: preview } : a.announcer, event, performance.now() / 1000, duration, id, remote, !!preview);
  if (!admitted) return;
  engine.stopAnnouncements();
  engine.play(`announcer_${admitted}` as SfxId, Math.max(0, Math.min(1, a.announcer.volume)));
  duckMusic(0.35, duration);
}
