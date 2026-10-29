// The native avatar renderer mirrors numbers that are private to the website's avatar/stage.ts: the pose scripts and
// the backdrop in src/avatar_pose.hpp and ui/avatar-host.ts, the framing in src/avatar_stage.hpp. The gestures and
// knife inspect lengths are exported from the web code itself (src/export-avatar.ts). When a re-sync changes one of
// these lines, this fails: follow the change in the native file named beside it.
import { test, expect } from "bun:test";

const stage = await Bun.file(new URL("../../web/src/avatar/stage.ts", import.meta.url)).text();

const POSES_AND_BACKDROPS: [string, string][] = [
  ["const DT = 1 / 120;", "avatar_pose.hpp pose_step_seconds"],
  ["const JUMP = 301.993;", "avatar_pose.hpp jump_speed"],
  ["const GRAV = 800;", "avatar_pose.hpp gravity"],
  ["const BASE_YAW = -62;", "avatar_pose.hpp base_yaw_degrees"],
  ["const SETTLE = 1.2;", "avatar_pose.hpp settle_seconds"],
  ["return { at: (_t, y) => stand(y), until: SETTLE + m * 3 };", "PoseScript idle"],
  ["return { at: (_t, y) => stand(y + 28, -38), until: SETTLE + m * 3 };", "PoseScript lookup"],
  ["({ ...stand(y, 10), crouched: true }), until: SETTLE + m * 2 };", "PoseScript crouch"],
  ["velocity: [...dir(y, 250), 0], forwardmove: 450 }), until: SETTLE + m * 0.9 };", "PoseScript run"],
  ["if (t < t0) return { ...stand(y), velocity: [...dir(y, 300), 0] };", "PoseScript hopping run-up"],
  ["velocity: [...dir(y, 400), h.vz], yaw: y, pitch: 6,", "PoseScript hop"],
  ["until: t0 + 0.04 + m * (HOP - 0.08),", "PoseScript hop"],
  ["const w = (t - t0) * 5;", "PoseScript strafe"],
  ["const yy = y + 50 * Math.sin(w);", "PoseScript strafe"],
  ["velocity: [...dir(yy, 700), h.vz], yaw: yy, pitch: 4,", "PoseScript strafe"],
  ["until: t0 + 0.08 + m * (HOP - 0.14),", "PoseScript strafe"],
  ["return { at: (_t, y) => stand(y, 8), until: SETTLE + 0.02 + m * 0.6,", "PoseScript swing"],
  ["signal: { at: SETTLE, attack: m > 0.5 ? 2 : 1 } };", "PoseScript swing signal"],
  ["const pitch = GESTURES[spec.pose]?.pitch ?? 6;", "avatar_pose.hpp default_gesture_pitch"],
  ['if (spec.hand !== "knife") return { at: (_t, y) => stand(y, 12), until: SETTLE + m * 3 };', "PoseScript showoff"],
  ["until: SETTLE + 0.1 + m * Math.max(0.2, len - 0.3), signal: { at: SETTLE, inspect: 1 } };", "PoseScript showoff"],
  ["const len = clip?.len ?? 2.4;", "avatar_pose.hpp default_inspect_seconds"],
  ["headRoll: h[2] + spec.tilt * 18,", "avatar_stage.hpp tilt_roll_degrees"],
  ["square: g.square ?? (g.reachR || g.reachL ? 1 : 0)", "actor_gestures.hpp parse_gesture"],
  ["new THREE.PerspectiveCamera(24,", "avatar_stage.hpp camera_fov_degrees"],
  ['const elev = spec.frame === "full" ? 8 : 5;', "avatar_stage.hpp elevations"],
  ['height = focus === "hand" ? 34 : 17;', "avatar_stage.hpp focus heights"],
  ['_v.y + (focus === "hand" ? 8 : 3)', "avatar_stage.hpp focus raises"],
  ["const ss = Math.min(2, Math.max(1, Math.floor(4096 / size)));", "avatar_stage.hpp supersample"],
  ['let top = "#26262d", bottom = "#0c0c0f", glow: string | null = null;', "avatar-host.ts STUDIO_TOP/BOTTOM"],
  ['glow = cosmetic(bg.slice(7))?.color ?? "#ffb43c";', "avatar-host.ts COLOURWAY_FALLBACK"],
  ['top = "#22222a";', "avatar-host.ts COLOURWAY_TOP"],
  ['bottom = "#0e0e12";', "avatar-host.ts COLOURWAY_BOTTOM"],
  ['ctx.fillStyle = "#1c1c22";', "avatar-host.ts MAP_FALLBACK"],
  [
    "ctx.createRadialGradient(size * 0.5, size * 0.28, 0, size * 0.5, size * 0.28, size * 0.7);",
    "avatar_picture.cpp light",
  ],
  ['r.addColorStop(0, glow ? hexA(glow, 0.42) : "rgba(255,255,255,0.16)");', "avatar_picture.cpp light alphas"],
];

// The v0.0.29 framing (the bigger head) that avatar_stage.hpp follows; checked once the vendored stage.ts has it.
const FITTED_FRAMING: [string, string][] = [
  ["const FIT_TOP = 0.92;", "avatar_stage.hpp fit_top_ndc"],
  ["const FIT_FULL = 0.88;", "avatar_stage.hpp fit_full_share"],
  ['const down = spec.frame === "face" ? 13.5 : spec.frame === "close" ? 21 : 32;', "avatar_stage.hpp reaches"],
  ['const k = spec.frame === "face" ? 1.14 : 1.1;', "avatar_stage.hpp paddings"],
  ["const lo = _head.y - down, cap = _head.y + 40;", "avatar_stage.hpp top_cap"],
  ["let hi = Math.max(_head.y + 20, Math.min(top + 2, cap));", "avatar_stage.hpp ear_room, top_margin"],
  ["hi += ((maxY - FIT_TOP) * height) / 2 / k + 0.25;", "avatar_stage.hpp fit_top_step"],
  ["height = (top - feet) * 1.14;", "avatar_stage.hpp full_padding"],
  ["Math.abs(need - 1) < 0.01 && Math.abs(mx) < 0.01 && Math.abs(my) < 0.01", "avatar_stage.hpp fit_tolerance"],
];

const missing = (lines: [string, string][]) =>
  lines.filter(([line]) => !stage.includes(line)).map(([, where]) => where);

test("the pose scripts and backdrops match the vendored stage.ts", () => {
  expect(missing(POSES_AND_BACKDROPS)).toEqual([]);
});

test.skipIf(!stage.includes("FIT_TOP"))("the framing matches the vendored stage.ts", () => {
  expect(missing(FITTED_FRAMING)).toEqual([]);
});
