// Web conformance cases from the v0.0.38 freeze (81962149).
import { describe, expect, it } from "bun:test";
import {
  heldActions,
  mixesMoveAndTurn,
  MAX_STEPS,
  MOVE_TURN_REFUSAL,
  releaseOf,
  runPress,
  runRelease,
  type ChainOps,
} from "../../web/src/console/bind-run";
import { chatMessageOf, sanitizeAliases, sanitizeCmdBinds, sayCommand } from "../../web/src/console/bind-store";
import {
  bindingOf,
  ChatGuard,
  ConsoleRunner,
  importConfig,
  listBinds,
  unknownIn,
  type ConsoleHost,
} from "../../web/src/console/exec";
import { normalize180, showPosLines } from "../../web/src/hud/showpos";
import { DEFAULT_PREFS, parsePrefs, type Prefs } from "../../web/src/ui/settings";
import { buildSettingsDoc, planSettingsImport } from "../../web/src/ui/settings-io";

const fresh = (): Prefs => JSON.parse(JSON.stringify(DEFAULT_PREFS));

/** Records what a press / release does. */
function rec() {
  const log: string[] = [];
  const ops: ChainOps = {
    hold: (a, own) => log.push(`+${a}${own ? "" : "*"}`),
    unhold: (a, own) => log.push(`-${a}${own ? "" : "*"}`),
    once: (c) => log.push(`once ${c}`),
    error: (t) => log.push(`error ${t}`),
  };
  return { log, ops };
}

describe("running a command bind (Source keys.cpp / CS:GO release)", () => {
  it("a chain holds every + command and lets go of them in press order", () => {
    const { log, ops } = rec();
    runPress("+moveleft; +jump", {}, ops);
    runRelease("+moveleft; +jump", {}, ops);
    expect(log).toEqual(["+left", "+jump", "-left", "-jump"]);
    expect(releaseOf('+jump; say "wheee"; +duck')).toEqual(["-jump", "-duck"]);
  });
  it("+alias / -alias pairs, and holds inside an alias belong to the alias", () => {
    const aliases = { "+mleft": "+moveleft; +duck", "-mleft": "-moveleft; -duck" };
    const { log, ops } = rec();
    runPress("+mleft", aliases, ops);
    runRelease("+mleft", aliases, ops);
    expect(log).toEqual(["+left*", "+duck*", "-left*", "-duck*"]);
  });
  it("other commands run once, on the press only", () => {
    const { log, ops } = rec();
    runPress('+jump; say "wheee"; slot1', {}, ops);
    runRelease('+jump; say "wheee"; slot1', {}, ops);
    expect(log).toEqual(["+jump", 'once say "wheee"', "once slot1", "-jump"]);
  });
  it("nested aliases expand; a loop stops with an error", () => {
    const { log, ops } = rec();
    runPress("a", { a: "b; echo one", b: "+duck; c", c: "say hi" }, ops);
    expect(log).toEqual(["+duck*", "once say hi", "once echo one"]);
    const loop = rec();
    runPress("x", { x: "y", y: "x" }, loop.ops);
    expect(loop.log.at(-1)).toMatch(/^error Alias "[xy]" nests deeper/);
    const wide = rec();
    runPress("w", { w: "v;v;v;v;v;v;v;v", v: "u;u;u;u;u;u;u;u", u: "t;t;t;t;t;t;t;t", t: "echo x" }, wide.ops);
    expect(wide.log.filter((l) => l.startsWith("once")).length).toBeLessThan(MAX_STEPS);
    expect(wide.log.at(-1)).toMatch(/^error Stopped after/);
  });
  it("the Source jump-toggle script works (aliases redefined at run time are the console's job)", () => {
    const aliases: Record<string, string> = { jt: "jon", jon: "+jump; alias jt joff", joff: "-jump; alias jt jon" };
    const { log, ops } = rec();
    runPress("jt", aliases, ops);
    expect(log).toEqual(["+jump*", "once alias jt joff"]);
    runRelease("jt", aliases, ops); // not a + bind: nothing to release, the jump stays held
    expect(log.length).toBe(2);
  });
  it("lists the actions a bind holds", () => {
    expect(heldActions("+mleft; slot1", { "+mleft": "+moveleft; +duck" })).toEqual(["left", "duck"]);
  });
});

/** A console over a plain prefs object. */
function host(p = fresh(), o: Partial<ConsoleHost> = {}) {
  const lines: string[] = [];
  const notices: string[] = [];
  let t = 0;
  const h: ConsoleHost & { p: Prefs; lines: string[]; notices: string[]; tick: (ms: number) => void } = {
    p,
    lines,
    notices,
    get: () => h.p,
    update: (fn) => fn(h.p),
    print: (text) => lines.push(text),
    clear: () => (lines.length = 0),
    notice: (text) => notices.push(text),
    now: () => t,
    tick: (ms) => (t += ms),
    ...o,
  };
  return { h, c: new ConsoleRunner(h) };
}

describe("console: chains, aliases, chat keys", () => {
  it("bind takes a chain, shows it, lists it, unbinds it", () => {
    const { h, c } = host();
    c.run('bind q "+moveleft; +jump"');
    expect(h.p.cmdBinds.KeyQ).toBe("+moveleft; +jump");
    expect(h.p.binds.lastWeapon).toEqual([]); // Q left its action
    c.run("bind q");
    expect(h.lines.at(-1)).toBe('"q" = "+moveleft; +jump"');
    expect(listBinds(h.p)).toContain('"q" = "+moveleft; +jump"');
    c.run("bind q +jump");
    expect(h.p.cmdBinds.KeyQ).toBeUndefined();
    expect(h.p.binds.jump).toContain("KeyQ");
    c.run('bind q "say gg"; unbind q');
    expect(bindingOf(h.p, "KeyQ")).toBeNull();
  });
  it("alias defines, shows, lists and removes; a bind to an unknown name says so", () => {
    const { h, c } = host();
    c.run('alias +mleft "+moveleft; +duck"; alias -mleft "-moveleft; -duck"; bind q +mleft');
    expect(h.p.aliases).toEqual({ "+mleft": "+moveleft; +duck", "-mleft": "-moveleft; -duck" });
    expect(h.p.cmdBinds.KeyQ).toBe("+mleft");
    c.run("alias");
    expect(h.lines.some((l) => l === "+mleft : +moveleft; +duck")).toBe(true);
    c.run("bind z dosomething");
    expect(h.lines.at(-1)).toMatch(/Not a command here \(yet\): dosomething/);
    c.run("unalias -mleft");
    expect("-mleft" in h.p.aliases).toBe(false);
    c.run("alias sensitivity x");
    expect(h.lines.at(-1)).toMatch(/already a command/);
  });
  it("an alias typed in the console runs its commands", () => {
    const { h, c } = host();
    c.run('alias fast "fps_max 0; cl_showfps 1"; fast');
    expect(h.p.graphics.fpsLimit).toBe(0);
    expect(h.p.hud.layout.fps.on).toBe(true);
  });
  it("a key's say goes through the chat path, chat commands too, and say_team is the room chat", () => {
    const sent: string[] = [];
    const { h, c } = host(fresh(), { chat: (l) => (sent.push(l), true) });
    c.runBound('say "nice run"');
    c.runBound("say !r");
    h.tick(1000); // (the chat guard: a second between bound messages)
    c.runBound("say_team gg");
    expect(sent).toEqual(["nice run", "!r", "gg"]);
  });
  it("the chat guard: one bound message a second, three in ten seconds; commands aren't limited", () => {
    const sent: string[] = [];
    const { h, c } = host(fresh(), { chat: (l) => (sent.push(l), true) });
    c.runBound("say gg");
    c.runBound("say gg");
    expect(sent).toEqual(["gg"]);
    expect(h.notices).toEqual(["Chat key: one message a second, three every ten seconds."]);
    for (let i = 0; i < 20; i++) c.runBound("say gg"); // held: no more notices
    expect(h.notices.length).toBe(1);
    h.tick(1000);
    c.runBound("say one");
    h.tick(1000);
    c.runBound("say two");
    h.tick(1000);
    c.runBound("say three"); // the fourth in ten seconds
    expect(sent).toEqual(["gg", "one", "two"]);
    h.tick(8000);
    c.runBound("say four");
    expect(sent.at(-1)).toBe("four");
    for (let i = 0; i < 5; i++) c.runBound("say !r"); // commands: as typed
    expect(sent.filter((s) => s === "!r").length).toBe(5);
    // Typed in the console: no guard.
    c.run("say a; say b");
    expect(sent.slice(-2)).toEqual(["a", "b"]);
  });
  it("ChatGuard alone", () => {
    const g = new ChatGuard();
    expect([0, 500, 1000, 2000, 3000, 9999, 10_001].map((t) => g.allow(t))).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
  });
  it("no chat to send to: a short line, also shown in game", () => {
    const { h, c } = host();
    c.runBound("say gg");
    expect(h.notices).toEqual(["Chat keys work in a map."]);
    const replies = host(fresh(), {
      chat: (_l, reply) => (reply("Not connected to the server: that didn't send."), true),
    });
    replies.c.runBound("say gg");
    expect(replies.h.notices).toEqual(["Not connected to the server: that didn't send."]);
  });
  it("bound once-commands don't echo; typed ones do", () => {
    const { h, c } = host();
    c.runBound("cl_showpos 1");
    expect(h.p.hud.showPos).toBe(1);
    expect(h.lines.some((l) => l.startsWith("]"))).toBe(false);
    c.run("cl_showpos 2");
    expect(h.lines.some((l) => l === "] cl_showpos 2")).toBe(true);
    expect(h.p.hud.showPos).toBe(2);
  });
  it("unknownIn finds what a chain can't run", () => {
    expect(unknownIn("+moveleft; +left; say hi; slot1; buymenu; +mleft", { "+mleft": "+left" })).toEqual(["buymenu"]);
    expect(unknownIn("+foo; -foo", {})).toEqual(["+foo", "-foo"]);
  });
});

describe("config import with chains and aliases", () => {
  const CFG = `alias "+mleft" "+moveleft; +duck"
alias "-mleft" "-moveleft; -duck"
bind "q" "+mleft"
bind "e" "+moveright; +jump"
bind "k" "say gg"
bind "j" "+jump; say wheee"
bind "l" "+jump; buymenu"
alias "bad name!" "x"`;
  it("takes them, notes what does nothing", () => {
    const r = importConfig(CFG, fresh());
    expect(r.prefs.aliases["+mleft"]).toBe("+moveleft; +duck");
    expect(r.prefs.cmdBinds.KeyQ).toBe("+mleft");
    expect(r.prefs.cmdBinds.KeyE).toBe("+moveright; +jump");
    expect(r.prefs.binds.use).toEqual([]);
    expect(r.prefs.cmdBinds.KeyK).toBe("say gg");
    expect(r.prefs.cmdBinds.KeyJ).toBe("+jump; say wheee");
    expect(r.lines.find((l) => l.command.startsWith('bind "l"'))!.note).toMatch(/buymenu does nothing here/);
    expect(r.lines.at(-1)!.status).toBe("error");
  });
  it("an alias defined after the bind still counts as known", () => {
    const r = importConfig('bind q +x\nalias +x "+jump"', fresh());
    expect(r.lines[0].note).not.toMatch(/does nothing/);
  });
});

describe("storing command binds", () => {
  it("parsePrefs keeps valid ones and frees their keys from actions", () => {
    const p = parsePrefs(
      JSON.stringify({
        cmdBinds: { KeyE: "+moveright; +jump", "bad key": "x", KeyZ: 5 },
        aliases: { "+MLeft": "+moveleft", "no way!": "x" },
      }),
    );
    expect(p.cmdBinds).toEqual({ KeyE: "+moveright; +jump" });
    expect(p.aliases).toEqual({ "+mleft": "+moveleft" });
    expect(p.binds.use).toEqual([]);
    expect(sanitizeCmdBinds({ A: "x".repeat(300) })).toEqual({});
    expect(sanitizeAliases({ "-x": "" })).toEqual({ "-x": "" });
  });
  it("settings export / import carries them", () => {
    const p = fresh();
    p.cmdBinds = { KeyK: 'say "gg"' };
    p.aliases = { "+mleft": "+moveleft; +duck" };
    const doc = buildSettingsDoc(p);
    const plan = planSettingsImport(JSON.parse(JSON.stringify(doc)), fresh());
    expect(plan.next.cmdBinds).toEqual({ KeyK: 'say "gg"' });
    expect(plan.next.aliases).toEqual({ "+mleft": "+moveleft; +duck" });
    expect(plan.changed).toEqual(expect.arrayContaining(["cmdBinds", "aliases"]));
    // A file without them binding my chat key to an action: the action wins.
    const mine = fresh();
    mine.cmdBinds = { KeyF: "say gg" };
    const other = buildSettingsDoc(fresh());
    delete (other.settings as Record<string, unknown>).cmdBinds;
    expect(planSettingsImport(JSON.parse(JSON.stringify(other)), mine).next.cmdBinds).toEqual({});
  });
  it("chat messages read back from the bind", () => {
    expect(chatMessageOf(sayCommand("nice run"))).toBe("nice run");
    expect(chatMessageOf("say gg")).toBe("gg");
    expect(chatMessageOf('say "a; b"')).toBe("a; b");
    expect(chatMessageOf("say gg; +jump")).toBeNull();
    expect(chatMessageOf("+jump")).toBeNull();
    expect(sayCommand('he said "hi"\nok')).toBe(`say "he said 'hi' ok"`);
  });
});

describe("cl_showpos", () => {
  const s = { pos: [-1234.5678, 0.004, 64], viewZ: 64, vel: [3, 4, 12], pitch: 12.345, yaw: 270 };
  it("prints CS:S's three lines, no name line (%.02f, 3D speed, angles in -180..180)", () => {
    expect(showPosLines(s, 1)).toEqual(["pos:  -1234.57 0.00 128.00", "ang:  12.35 -90.00 0.00", "vel:  13.00"]);
  });
  it("cl_showpos 2: the feet and the body's angles", () => {
    expect(showPosLines(s, 2)).toEqual(["pos:  -1234.57 0.00 64.00", "ang:  0.00 -90.00 0.00", "vel:  13.00"]);
  });
  it("normalizes like AngleNormalize, and prints -0.00 as C does", () => {
    expect([0, 180, 181, -180, 359.5, 720].map(normalize180)).toEqual([0, 180, -179, 180, -0.5, 0]);
    expect(showPosLines({ ...s, pos: [-0.001, 0, 0], viewZ: 0 }, 1)[0]).toBe("pos:  -0.00 0.00 0.00");
  });
});

describe("moving and turning on one key is refused (owner, 11-06)", () => {
  it("mixesMoveAndTurn sees through chains and nested aliases; everything else is allowed", () => {
    expect(mixesMoveAndTurn("+moveleft; +left", {})).toBe(true);
    expect(mixesMoveAndTurn("+forward; +speed", {})).toBe(true);
    expect(mixesMoveAndTurn("a", { a: "b; +back", b: "c", c: "+right" })).toBe(true);
    expect(mixesMoveAndTurn("+moveleft; -moveleft; +left", {})).toBe(true); // starts both on one press
    for (const ok of [
      "+left",
      "+left; +speed",
      "+moveleft; +moveright",
      "+jump; +duck",
      "+jump; say wheee",
      "say gg",
      "+jump_toggle",
      "+moveleft; +jump",
    ])
      expect(mixesMoveAndTurn(ok, {})).toBe(false);
  });
  it("bind refuses it, prefs untouched", () => {
    const { h, c } = host();
    const before = JSON.stringify(h.p);
    c.run('bind q "+moveleft; +left"');
    expect(h.lines.at(-1)).toBe(MOVE_TURN_REFUSAL);
    c.run('alias turn "+right"; bind e "+forward; turn"');
    expect(h.lines.at(-1)).toBe(MOVE_TURN_REFUSAL);
    expect(h.p.cmdBinds).toEqual({});
    c.run("unalias turn");
    expect(JSON.stringify(h.p)).toBe(before);
    c.run('bind q "+left; +speed"; bind e "+forward; +jump"');
    expect(h.p.cmdBinds).toEqual({ KeyQ: "+left; +speed", KeyE: "+forward; +jump" });
  });
  it("alias refuses a definition that moves and turns, or that would make a bound key do so (toggles included)", () => {
    const { h, c } = host();
    c.run('alias +mleft "+moveleft; +left"');
    expect(h.lines.at(-1)).toBe(MOVE_TURN_REFUSAL);
    expect(h.p.aliases).toEqual({});
    c.run('alias tg "+jump"; bind t "+moveleft; tg"');
    expect(h.p.cmdBinds.KeyT).toBe("+moveleft; tg");
    c.run('alias tg "+left"'); // the toggle switching t to move and turn
    expect(h.lines.at(-1)).toBe("Moving and turning on one key isn't allowed: t is bound to +moveleft; tg.");
    expect(h.p.aliases.tg).toBe("+jump");
    // A key's own toggle script redefining an alias goes through the same check.
    c.runBound('alias tg "+right"');
    expect(h.notices.at(-1)).toMatch(/^Moving and turning on one key isn't allowed/);
    expect(h.p.aliases.tg).toBe("+jump");
  });
  it("config import lists them as not imported, with the reason", () => {
    const r = importConfig(
      `bind "e" "+moveright; +right"
alias "+strafeturn" "+moveleft; +left"
bind "q" "+forward; later"
alias "later" "+left"
bind "w" "+forward"
bind "kp_end" "+left; +speed"`,
      fresh(),
    );
    const st = (c: string) => r.lines.find((l) => l.command.startsWith(c))!;
    expect(st('bind "e"').status).toBe("error");
    expect(st('bind "e"').note).toBe("Moving and turning on one key isn't allowed");
    expect(st('alias "+strafeturn"').status).toBe("error");
    // An alias defined after a bind that it would make move and turn: the alias isn't imported, the bind keeps only
    // what it can do (it notes the missing alias).
    expect(st('alias "later"').status).toBe("error");
    expect(st('alias "later"').note).toBe("Moving and turning on one key isn't allowed: q is bound to +forward; later");
    expect(st('bind "q"').note).toMatch(/later does nothing here/);
    expect(r.prefs.aliases.later).toBeUndefined();
    expect(r.prefs.cmdBinds.KeyE).toBeUndefined();
    expect(r.prefs.cmdBinds.Numpad1).toBe("+left; +speed"); // turn-only: fine
    expect(r.prefs.binds.forward).toContain("KeyW");
  });
});
