// Web conformance cases from the v0.0.38 freeze (81962149).
// Every player setting is a console variable, or listed in NOT_CONSOLE with why (console/cvars.ts). A new setting
// fails this until it's given a cvar or a reason. Plus the classic commands and saved configs (console/exec.ts).
import { describe, expect, it } from "bun:test";
import {
  CVARS,
  cvarDefault,
  findCvar,
  NOT_CONSOLE,
  parseColor,
  setCvar,
  type Cvar,
  type CvarValue,
} from "../../web/src/console/cvars";
import {
  complete,
  ConsoleRunner,
  configName,
  importConfig,
  writeConfigText,
  type ConfigStore,
  type ConsoleHost,
} from "../../web/src/console/exec";
import { DEFAULT_PREFS, type Prefs } from "../../web/src/ui/settings";

const fresh = (): Prefs => JSON.parse(JSON.stringify(DEFAULT_PREFS));
const leaves = (o: unknown, at = ""): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? leaves(v, `${at}${k}.`) : [at + k],
  );
const at = (o: unknown, path: string) =>
  path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o);

/** Another valid value for `c` than the current one. */
function other(c: Cvar, cur: CvarValue): CvarValue {
  if (c.bool) return cur ? 0 : 1;
  if (c.values) return c.values.find((v) => v !== cur)!;
  if (c.color) return cur === "#123456" ? "#654321" : "#123456";
  const [lo, hi] = c.range!;
  return cur === lo ? hi : lo;
}

describe("console variables cover the settings", () => {
  it("every setting is a cvar or in NOT_CONSOLE", () => {
    const touched = new Set<string>();
    const all = leaves(DEFAULT_PREFS);
    for (const c of CVARS) {
      const p = fresh();
      c.set(p, other(c, c.get(p)));
      for (const l of all) if (JSON.stringify(at(p, l)) !== JSON.stringify(at(DEFAULT_PREFS, l))) touched.add(l);
    }
    const listed = (l: string) => Object.keys(NOT_CONSOLE).some((k) => l === k || l.startsWith(k + "."));
    const missing = all.filter((l) => !touched.has(l) && !listed(l));
    expect(missing).toEqual([]);
    // (and nothing listed as not-console is actually a cvar)
    expect(Object.keys(NOT_CONSOLE).filter((k) => touched.has(k))).toEqual(
      ["dpiConfirmed"].filter((k) => touched.has(k)),
    );
  });
  it("names and aliases are unique and lower case", () => {
    const names = CVARS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((x) => x === x.toLowerCase())).toBe(true);
  });
  it("every default reads back and is accepted", () => {
    for (const c of CVARS) {
      const p = fresh();
      expect([c.name, setCvar(p, c, String(cvarDefault(c)))]).toEqual([c.name, null]);
      expect(c.get(p)).toBe(cvarDefault(c));
    }
  });
  it("the classic names", () => {
    for (const n of [
      "fps_max",
      "maxfps",
      "cl_showfps",
      "net_graph",
      "cl_showpos",
      "fov_desired",
      "viewmodel_fov",
      "viewmodel_offset_x",
      "cl_righthand",
      "r_drawviewmodel",
      "crosshair",
      "cl_crosshairsize",
      "cl_crosshairgap",
      "cl_crosshairthickness",
      "cl_crosshaircolor",
      "cl_crosshairdot",
      "cl_crosshairstyle",
      "cl_crosshair_drawoutline",
      "cl_crosshairalpha",
      "volume",
      "snd_musicvolume",
      "sensitivity",
      "m_yaw",
      "m_pitch",
      "m_rawinput",
      "cl_yawspeed",
      "hud_scale",
      "cl_showtriggers",
      "cl_showclips",
      "r_quality",
      "r_look",
      "mat_fullbright",
    ])
      expect([n, !!findCvar(n)]).toEqual([n, true]);
    expect(findCvar("maxfps")).toBe(findCvar("fps_max")!);
  });
  it("choices by name or number, colours, crosshair dot and alpha, quality preset, net_graph", () => {
    const p = fresh();
    expect(setCvar(p, findCvar("cl_crosshairstyle")!, "circle")).toBeNull();
    expect(p.crosshair.style).toBe("circle");
    expect(setCvar(p, findCvar("cl_crosshairstyle")!, "0")).toBeNull();
    expect(p.crosshair.style).toBe("cross");
    expect(setCvar(p, findCvar("cl_crosshairdot")!, "1")).toBeNull();
    expect(p.crosshair.style).toBe("cross-dot");
    expect(setCvar(p, findCvar("cl_crosshairstyle")!, "star")).toMatch(/one of: cross, cross-dot/);
    expect(setCvar(p, findCvar("cl_crosshaircolor")!, "255 0 128")).toBeNull();
    expect(p.crosshair.color).toBe("#ff0080");
    expect(setCvar(p, findCvar("cl_crosshaircolor_g")!, "255")).toBeNull();
    expect(p.crosshair.color).toBe("#ffff80");
    expect(parseColor("#abc")).toBe("#aabbcc");
    expect(setCvar(p, findCvar("cl_crosshairalpha")!, "128")).toBeNull();
    expect(p.crosshair.alpha).toBeCloseTo(0.502, 3);
    expect(setCvar(p, findCvar("r_quality")!, "low")).toBeNull();
    expect(p.graphics.potato).toBe(true);
    expect(findCvar("r_quality")!.get(p)).toBe("low");
    p.graphics.anisotropy = 2;
    expect(findCvar("r_quality")!.get(p)).toBe("custom");
    expect(setCvar(p, findCvar("net_graph")!, "1")).toBeNull();
    expect(p.hud.netGraph && p.hud.layout.fps.on).toBe(true);
    expect(setCvar(p, findCvar("mat_forceaniso")!, "3")).toMatch(/1, 2, 4, 8 or 16/);
  });
});

function host(o: Partial<ConsoleHost> = {}) {
  const lines: string[] = [];
  const saved = new Map<string, string>();
  const configs: ConfigStore = {
    list: () => [...saved.keys()].sort(),
    get: (n) => saved.get(n) ?? null,
    set: (n, t) => (saved.set(n, t), null),
  };
  const h: ConsoleHost & { p: Prefs; lines: string[] } = {
    p: fresh(),
    lines,
    get: () => h.p,
    update: (fn) => fn(h.p),
    print: (t) => lines.push(t),
    clear: () => (lines.length = 0),
    configs,
    ...o,
  };
  return { h, c: new ConsoleRunner(h), saved };
}

describe("classic commands", () => {
  it("kill, retry, map, disconnect / quit, noclip go to the game", () => {
    const calls: string[] = [];
    const { h, c } = host({
      action: (a) => (calls.push(a), true),
      retry: () => (calls.push("retry"), true),
      openMap: (m) => (calls.push(`map ${m}`), null),
      menu: () => (calls.push("menu"), true),
    });
    c.run("kill; retry; map bhop_eazy; disconnect; quit; noclip; +crouchjump");
    expect(calls).toEqual(["restart", "retry", "map bhop_eazy", "menu", "menu", "noclip"]);
    expect(h.lines.at(-1)).toMatch(/for keys/);
    const bare = host();
    bare.c.run("kill");
    expect(bare.h.lines.at(-1)).toBe("kill: only in a map.");
  });
  it("map completes names", () => {
    expect(complete("map bhop_e", ["bhop_eazy", "bhop_easy", "bhop_x"]).options).toEqual(["bhop_eazy", "bhop_easy"]);
    expect(complete("map bhop_x", ["bhop_eazy", "bhop_x"]).line).toBe("map bhop_x ");
  });
  it("host_writeconfig then exec puts the same setup back (binds, chains, aliases, settings)", () => {
    const { h, c, saved } = host();
    c.run(
      'sensitivity 1.7; m_yaw 0.0165; fps_max 300; cl_crosshaircolor "#00ffaa"; cl_crosshairstyle t; r_aspect 4:3; cl_showpos 2; snd_musicmode menus',
    );
    c.run(
      'bind mouse4 +crouchjump; bind k "say nice run"; bind e "+jump; +duck"; alias +cj "+duck; +jump"; alias -cj "-jump; wait; -duck"; bind ctrl +cj',
    );
    const want = JSON.parse(JSON.stringify(h.p)) as Prefs;
    c.run("host_writeconfig mine");
    expect(saved.get("mine")).toMatch(/^\/\/ bunnyhop.lol config "mine"/);
    expect(saved.get("mine")).toContain('bind "k" "say nice run"');
    h.p = fresh();
    c.run("exec mine.cfg");
    expect(h.p.binds).toEqual(want.binds);
    expect(h.p.cmdBinds).toEqual(want.cmdBinds);
    expect(h.p.aliases).toEqual(want.aliases);
    for (const k of [
      "sensitivity",
      "mYaw",
      "volume",
      "crosshair",
      "graphics",
      "hud",
      "audio",
      "viewmodel",
      "ghost",
      "triggers",
    ] as const)
      expect([k, h.p[k]]).toEqual([k, want[k]]);
    c.run("exec");
    expect(h.lines.at(-1)).toBe("Saved configs: mine. exec <name> loads one.");
    c.run("exec nope");
    expect(h.lines.at(-1)).toMatch(/No saved config "nope"/);
    expect(configName("Auto.CFG")).toBe("auto");
    expect(configName("../x")).toBe("");
  });
  it("a written config is a plain Source config any CS:S-style import reads", () => {
    const text = writeConfigText(fresh(), "x");
    const r = importConfig(text, fresh(), { keepOwn: false });
    expect(r.lines.filter((l) => l.status === "error" || l.status === "skipped")).toEqual([]);
    expect(r.changed).toBe(false);
  });
  it("help and find cover the new commands; wait typed in the console does nothing", () => {
    const { h, c } = host();
    c.run("help");
    for (const n of [
      "kill",
      "retry",
      "map",
      "disconnect",
      "exec",
      "host_writeconfig",
      "alias",
      "incrementvar",
      "cvarlist",
      "find",
    ])
      expect([n, h.lines.some((l) => l.trim().startsWith(n + " ") || l.trim() === n)]).toEqual([n, true]);
    h.lines.length = 0;
    c.run("find maxfps");
    expect(h.lines[1]).toMatch(/^"fps_max"/);
    h.lines.length = 0;
    c.run("wait");
    expect(h.lines).toEqual(["] wait"]);
  });
});
