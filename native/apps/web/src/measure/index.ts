import type * as THREE from "three";
import { registerChatCommand } from "../chat-commands";
import { postLocalLine } from "../net/hud";
import { toast } from "../notify";
import { h } from "../ui/dom";
import { registerSettingsSection } from "../ui/settings-registry";
import { actions, button, group } from "../ui/controls";
import { keyLabel, prefs } from "../ui/settings";
import { MeasureOverlay } from "./overlay";
import "./measure.css";

let host: { overlay: MeasureOverlay; camera: THREE.Camera; canMeasure: () => boolean } | null = null;
let pending = false, say: (text: string) => void = postLocalLine;
let label: HTMLElement | null = null, labelAt = -Infinity, unobstructed = false;
export function initMeasure(world: THREE.Object3D, scene: THREE.Object3D, camera: THREE.Camera, canMeasure: () => boolean, sky: THREE.Object3D[]): void {
  host?.overlay.dispose(); label?.remove();
  host = { overlay: new MeasureOverlay(world, scene, new Set(sky)), camera, canMeasure };
  label = h("div.measure-label", { hidden: true }); document.body.append(label); pending = false;
}
export function requestMeasure(reply: (text: string) => void = postLocalLine): void {
  if (!host?.canMeasure()) { reply("Measurement is available while playing a map."); return; }
  pending = true; say = reply;
}
export function clearMeasure(): void { pending = false; host?.overlay.clear(); if (label) label.hidden = true; }
export function measureVisible(on: boolean): void { if (host) host.overlay.root.visible = on; if (!on && label) label.hidden = true; }
export function measureFrame(now: number, visible: boolean): void {
  if (!host || !label) return;
  measureVisible(visible);
  if (!host.canMeasure()) { pending = false; label.hidden = true; return; }
  if (pending) {
    pending = false;
    if (!host.overlay.pick(host.camera)) say("No surface in range. Aim at a nearby wall or floor.");
    else { labelAt = -Infinity; say(host.overlay.count === 1 ? "Point 1 set. Aim at the other edge and use !measure again (or your Set measurement point key)." : host.overlay.update()!.text); }
  }
  const result = host.overlay.update();
  if (!result || !visible) { label.hidden = true; return; }
  const point = result.midpoint.clone().project(host.camera);
  if (now - labelAt > 100) { labelAt = now; unobstructed = host.overlay.labelVisible(host.camera, result.midpoint); }
  label.hidden = !unobstructed || point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
  if (!label.hidden) {
    if (label.textContent !== result.text) label.textContent = result.text;
    // Match the canvas's letterboxed viewport instead of assuming it covers the window.
    const rect = document.querySelector("canvas")!.getBoundingClientRect();
    label.style.left = `${rect.left + (point.x + 1) * rect.width / 2}px`;
    label.style.top = `${rect.top + (1 - point.y) * rect.height / 2}px`;
  }
}

export function registerMeasure(): void {
  registerChatCommand({ name: "measure", aliases: ["distance"], args: "[clear]", help: "measure between two aimed points", group: "more", key: "measurePoint", where: "both", run: (ctx, arg) => {
    if (arg.toLowerCase() === "clear") { clearMeasure(); ctx.reply("Measurement cleared."); }
    else if (arg) ctx.reply("Usage: !measure [clear]. Aim at a surface and use it twice to measure a gap.");
    else requestMeasure(text => ctx.reply(text));
  } });
  registerChatCommand({ name: "clearmeasure", help: "clear your measurement", group: "more", key: "clearMeasure", where: "both", run: ctx => { clearMeasure(); ctx.reply("Measurement cleared."); } });
  registerSettingsSection("measure", () => {
    const key = prefs.get().binds.measurePoint[0];
    return [group("Distance measurement",
      actions("Measurement", [button("Set aimed point", () => requestMeasure(text => toast(text))), button("Clear measurement", clearMeasure)], {
        hint: key ? `${keyLabel(key)} at each point` : "!measure at each point",
        desc: "Full distance, horizontal gap and height difference, in Source units. A third point starts a new measurement. Only you see it; it clears when you leave the map.",
        keywords: "measure ruler distance gap height point",
      }),
    )];
  }, { label: "Measure", icon: "measure", order: 46 });
}
