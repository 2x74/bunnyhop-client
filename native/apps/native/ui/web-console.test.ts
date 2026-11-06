// Web conformance cases from the v0.0.38 freeze (81962149).
import { describe, expect, it } from "bun:test";
import { argString, splitCommands, tokenize } from "../../web/src/console/parse";
import { actionForCommand, codeForKey, commandForAction, keyForCode } from "../../web/src/console/names";
import {
  complete,
  ConsoleRunner,
  importConfig,
  listBinds,
  type ConsoleHost,
  type LineKind,
} from "../../web/src/console/exec";
import { CVARS, cvarDefault, findCvar, setCvar } from "../../web/src/console/cvars";
import { DEFAULT_PREFS, parsePrefs, type Prefs } from "../../web/src/ui/settings";
import { DEFAULT_BINDS } from "../../web/src/binds";

const fresh = (): Prefs => JSON.parse(JSON.stringify(DEFAULT_PREFS));

/** A console over a plain prefs object, collecting what it prints. */
function host(p = fresh(), o: Partial<ConsoleHost> = {}) {
  const lines: { text: string; kind: LineKind }[] = [];
  let t = 0;
  const h: ConsoleHost & { p: Prefs; lines: typeof lines; tick: (ms: number) => void; last: () => string } = {
    p,
    lines,
    get: () => h.p,
    update: (fn) => fn(h.p),
    print: (text, kind = "out") => lines.push({ text, kind }),
    clear: () => (lines.length = 0),
    now: () => t,
    tick: (ms) => (t += ms),
    last: () => lines[lines.length - 1]?.text ?? "",
    ...o,
  };
  return { h, c: new ConsoleRunner(h) };
}

describe("console syntax (Source command buffer)", () => {
  it("splits at ; and newlines outside quotes, drops // comments", () => {
    expect(splitCommands('bind w +forward; bind s "+back" // walk\nsensitivity 2\r\n\n  ')).toEqual([
      "bind w +forward",
      'bind s "+back"',
      "sensitivity 2",
    ]);
    expect(splitCommands('bind f "+jump; +duck"')).toEqual(['bind f "+jump; +duck"']);
    expect(splitCommands('echo "a // not a comment"')).toEqual(['echo "a // not a comment"']);
  });
  it("tokenizes quoted words as one", () => {
    expect(tokenize('bind "MOUSE4" "+jump"')).toEqual(["bind", "MOUSE4", "+jump"]);
    expect(tokenize('say "hi there"  x')).toEqual(["say", "hi there", "x"]);
    expect(tokenize('bind "\'" slot1')).toEqual(["bind", "'", "slot1"]);
    expect(tokenize('echo "unclosed rest')).toEqual(["echo", "unclosed rest"]);
    expect(argString('echo "hello world"')).toBe("hello world");
    expect(argString("say !r now")).toBe("!r now");
  });
});

describe("Source key and command names", () => {
  it("maps key names both ways", () => {
    const pairs: [string, string][] = [
      ["MOUSE1", "Mouse1"],
      ["mouse5", "Mouse5"],
      ["MWHEELUP", "MWheelUp"],
      ["mwheeldown", "MWheelDown"],
      ["SPACE", "Space"],
      ["CTRL", "ControlLeft"],
      ["SHIFT", "ShiftLeft"],
      ["ALT", "AltLeft"],
      ["w", "KeyW"],
      ["4", "Digit4"],
      ["F12", "F12"],
      ["KP_END", "Numpad1"],
      ["KP_INS", "Numpad0"],
      ["kp_enter", "NumpadEnter"],
      ["SEMICOLON", "Semicolon"],
      ["`", "Backquote"],
      ["uparrow", "ArrowUp"],
    ];
    for (const [n, c] of pairs) expect(codeForKey(n)).toBe(c);
    expect(codeForKey("KP_1")).toBe("Numpad1");
    expect(codeForKey("bogus")).toBeNull();
    expect(keyForCode("KeyW")).toBe("w");
    expect(keyForCode("Mouse4")).toBe("MOUSE4");
    expect(keyForCode("Numpad1")).toBe("KP_END");
    expect(keyForCode("MouseWheel")).toBe("MWHEEL");
  });
  it("maps Source commands to actions", () => {
    const pairs: [string, string][] = [
      ["+forward", "forward"],
      ["+back", "back"],
      ["+moveleft", "left"],
      ["+moveright", "right"],
      ["+jump", "jump"],
      ["+duck", "duck"],
      ["+attack", "attack"],
      ["+attack2", "attack2"],
      ["slot1", "slot1"],
      ["slot3", "slot3"],
      ["lastinv", "lastWeapon"],
      ["invnext", "nextWeapon"],
      ["invprev", "prevWeapon"],
      ["drop", "drop"],
      ["+reload", "reload"],
      ["jump_toggle", "jumpToggle"],
      ["+jump_toggle", "jumpToggle"],
      ["+left", "turnLeft"],
      ["+speed", "turnFast"],
      ["impulse 100", "flashlight"],
      ["IMPULSE   100", "flashlight"],
      ["toggleconsole", "console"],
      ["sm_r", "restart"],
    ];
    for (const [c, a] of pairs) expect(actionForCommand(c)).toBe(a as never);
    expect(actionForCommand("+showscores")).toBeNull();
    expect(actionForCommand("say !wr")).toBeNull();
    expect(actionForCommand("say !r")).toBeNull(); // a say bind goes through the chat (a command bind)
    expect(commandForAction("left")).toBe("+moveleft");
    expect(commandForAction("jumpToggle")).toBe("jump_toggle");
  });
});

describe("console commands", () => {
  it("bind shows and sets, taking the key from its old action", () => {
    const { h, c } = host();
    c.run("bind space");
    expect(h.last()).toBe('"SPACE" = "+jump"');
    c.run("bind mouse4 jump_toggle");
    expect(h.p.binds.jumpToggle).toEqual(["Mouse4"]);
    c.run('bind "e" "+jump"');
    expect(h.p.binds.use).toEqual([]);
    expect(h.p.binds.jump).toContain("KeyE");
    expect(h.last()).toContain("it was +use");
  });
  it("a fourth key on one action replaces its oldest", () => {
    const { h, c } = host();
    c.run("bind f +forward; bind g +forward; bind h +forward");
    expect(h.p.binds.forward).toEqual(["KeyF", "KeyG", "KeyH"]);
  });
  it("splits and joins the either-direction wheel bind", () => {
    const { h, c } = host();
    expect(h.p.binds.jump).toEqual(["Space", "MouseWheel"]);
    c.run("bind mwheelup invprev");
    expect(h.p.binds.jump).toEqual(["Space", "MWheelDown"]);
    expect(h.p.binds.prevWeapon).toEqual(["MWheelUp"]);
    c.run("bind mwheelup +jump");
    expect(h.p.binds.jump).toEqual(["Space", "MouseWheel"]);
    c.run("unbind mwheeldown");
    expect(h.p.binds.jump).toEqual(["Space", "MWheelUp"]);
  });
  it("refuses Esc, Source commands that don't exist here and missing slots, with a reason", () => {
    const { h, c } = host();
    c.run("bind escape +jump");
    expect(h.last()).toMatch(/Esc/);
    c.run("bind f +showscores");
    expect(h.last()).toMatch(/scoreboard/);
    c.run("bind q slot5");
    expect(h.last()).toMatch(/three weapon slots/);
    expect(h.p.binds.inspect).toEqual(["KeyF"]);
  });
  it("unbindall asks first, keeps the console key; binds_default restores", () => {
    const { h, c } = host();
    c.run("unbindall");
    expect(h.p.binds.forward).toEqual(["KeyW"]);
    expect(h.last()).toMatch(/again within 10 seconds/);
    h.tick(11_000);
    c.run("unbindall");
    expect(h.p.binds.forward).toEqual(["KeyW"]); // the window ran out: asked again
    c.run("unbindall");
    expect(h.p.binds.forward).toEqual([]);
    expect(h.p.binds.console).toEqual(["Backquote"]);
    c.run("binds_default");
    expect(h.p.binds).toEqual(DEFAULT_BINDS);
  });
  it("binds lists every key in Source names", () => {
    const l = listBinds(fresh());
    expect(l).toContain('"w" = "+forward"');
    expect(l).toContain('"MWHEEL" = "+jump"');
    expect(l).toContain('"`" = "toggleconsole"');
  });
  it("cvars show Source-style and set through the same validation", () => {
    const { h, c } = host();
    c.run("sensitivity");
    expect(h.lines.at(-1)!.text).toContain('"sensitivity" = "2" ( def. "2" )');
    c.run("sensitivity 1.75; m_yaw 0.07");
    expect(h.p.sensitivity).toBe(1.75);
    expect(h.p.mYaw).toBe(0.07);
    c.run("m_yaw 5");
    expect(h.p.mYaw).toBe(0.07);
    expect(h.last()).toMatch(/m_yaw goes from/);
    c.run("m_pitch -0.022");
    expect(h.p.invertY).toBe(true);
    expect(h.p.mPitch).toBe(0.022);
    c.run("fps_max 0; cl_showfps 1; volume 0.5");
    expect(h.p.graphics.fpsLimit).toBe(0);
    expect(h.p.hud.layout.fps.on).toBe(true);
    expect(h.p.volume).toBe(0.5);
    c.run("fps_max 10");
    expect(h.p.graphics.fpsLimit).toBe(0);
    c.run("fov_desired 200");
    expect(h.p.fov).toBe(90);
  });
  it("toggle flips a switch or steps through values; incrementvar wraps", () => {
    const { h, c } = host();
    c.run("toggle cl_showfps");
    expect(h.p.hud.layout.fps.on).toBe(!DEFAULT_PREFS.hud.layout.fps.on);
    c.run("toggle fps_max 144 240 0");
    expect(h.p.graphics.fpsLimit).toBe(144);
    c.run("toggle fps_max 144 240 0");
    expect(h.p.graphics.fpsLimit).toBe(240);
    c.run("volume 0.5; incrementvar volume 0 1 0.3");
    expect(h.p.volume).toBe(0.8);
    c.run("incrementvar volume 0 1 0.3");
    expect(h.p.volume).toBe(0); // past max: back to min, as in Source
  });
  it("echo, help, find, clear, did-you-mean, server cvars", () => {
    const { h, c } = host();
    c.run('echo "hello there"');
    expect(h.last()).toBe("hello there");
    c.run("find yaw");
    expect(h.lines.some((l) => l.text.includes('"m_yaw"'))).toBe(true);
    c.run("help bind");
    expect(h.last()).toMatch(/^bind <key>/);
    c.run("sensitivty 3");
    expect(h.last()).toMatch(/Did you mean sensitivity/);
    c.run("sv_airaccelerate 1000");
    expect(h.last()).toMatch(/server setting/);
    c.run("clear");
    expect(h.lines.length).toBe(0);
  });
  it("chat commands and actions go to the game, or say there is none", () => {
    const sent: string[] = [];
    const ran: string[] = [];
    const { h, c } = host(fresh(), { chat: (l) => (sent.push(l), true), action: (a) => (ran.push(a), true) });
    c.run("!r; say /practice; restart; jump_toggle; slot1");
    expect(sent).toEqual(["!r", "/practice"]);
    expect(ran).toEqual(["restart", "jumpToggle", "slot1"]);
    c.run("+jump");
    expect(h.last()).toMatch(/for keys/);
    const bare = host();
    bare.c.run("!r");
    expect(bare.h.last()).toMatch(/in a map/);
  });
  it("tab completion", () => {
    expect(complete("sensi").line).toBe("sensitivity ");
    expect(complete("m_").options).toEqual(expect.arrayContaining(["m_yaw", "m_pitch", "m_rawinput"]));
    expect(complete("bind mouse").options).toEqual(expect.arrayContaining(["mouse1", "mouse5"]));
    expect(complete("bind mouse4 +ju").line).toBe("bind mouse4 +jump ");
    expect(complete("bind mouse4 +mo").options).toEqual(["+moveleft", "+moveright"]);
    expect(complete("bind mouse4 +mo").line).toBe("bind mouse4 +move");
    expect(complete("bind mouse4 jump_t").line).toBe("bind mouse4 jump_toggle ");
  });
});

describe("cvars", () => {
  it("every default reads back from DEFAULT_PREFS and is accepted", () => {
    for (const c of CVARS) {
      const p = fresh();
      expect(setCvar(p, c, String(cvarDefault(c)))).toBeNull();
      expect(c.get(p)).toBe(cvarDefault(c));
    }
  });
  it("names are unique and lower case", () => {
    const names = CVARS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n === n.toLowerCase())).toBe(true);
    expect(findCvar("SENSITIVITY")?.name).toBe("sensitivity");
  });
});

const CSS_CFG = `unbindall
bind "0" "slot10"
bind "1" "slot1"
bind "2" "slot2"
bind "3" "slot3"
bind "4" "slot4"
bind "a" "+moveleft"
bind "b" "buymenu"
bind "c" "radio3"
bind "d" "+moveright"
bind "e" "+use"
bind "f" "impulse 100"
bind "g" "drop"
bind "q" "lastinv"
bind "r" "+reload"
bind "s" "+back"
bind "w" "+forward"
bind "y" "messagemode"
bind "\`" "toggleconsole"
bind "SPACE" "+jump"
bind "TAB" "+showscores"
bind "ESCAPE" "cancelselect"
bind "CTRL" "+duck"
bind "MOUSE1" "+attack"
bind "MOUSE2" "+attack2"
bind "MWHEELDOWN" "+jump"
bind "MWHEELUP" "+jump"
bind "MOUSE4" "say !r"
bind "x" "+jump; +duck"
sensitivity "1.8"
m_yaw "0.022"
m_rawinput "1"
fps_max "300"
cl_showfps "1"
volume "0.4"
m_customaccel "0"
cl_crosshairsize "3"
sv_cheats "1"
alias "+jt" "+jump"
`;

describe("config import", () => {
  it("imports a CS:S config.cfg, keeps this game's own keys, reports the rest", () => {
    const base = fresh();
    const r = importConfig(CSS_CFG, base);
    const p = r.prefs;
    expect(base.binds).toEqual(DEFAULT_BINDS); // a copy: nothing written
    expect(r.changed).toBe(true);
    expect(p.sensitivity).toBe(1.8);
    expect(p.rawInput).toBe(true);
    expect(p.graphics.fpsLimit).toBe(300);
    expect(p.hud.layout.fps.on).toBe(true);
    expect(p.volume).toBe(0.4);
    expect(p.binds.forward).toEqual(["KeyW"]);
    expect(p.binds.jump).toEqual(["Space", "MouseWheel"]);
    expect(p.binds.flashlight).toEqual(["KeyF"]);
    expect(p.binds.reload).toEqual([]); // R stays on restart
    expect(p.binds.restart).toEqual(["KeyR"]);
    expect(p.cmdBinds.Mouse4).toBe("say !r"); // through the chat, as typed
    expect(p.cmdBinds.KeyX).toBeUndefined(); // X teleports to the checkpoint here: kept
    expect(p.binds.cpTeleport).toEqual(["KeyX"]);
    expect(p.binds.setStart).toEqual(["Digit4"]); // slot4 isn't a slot here; 4 keeps its own action
    expect(p.binds.cpSave).toEqual(["KeyC"]);
    expect(p.binds.chat).toEqual(["KeyY"]);
    expect(p.binds.console).toEqual(["Backquote"]);
    const status = (cmd: string) => r.lines.find((l) => l.command.startsWith(cmd))?.status;
    expect(status('bind "r"')).toBe("kept");
    expect(status('bind "b"')).toBe("skipped");
    expect(status('bind "x"')).toBe("kept");
    expect(status('bind "ESCAPE"')).toBe("skipped");
    expect(status("m_customaccel")).toBe("skipped");
    expect(status("cl_crosshairsize")).toBe("set"); // (in pixels here)
    expect(p.crosshair.size).toBe(3);
    expect(status("sv_cheats")).toBe("skipped");
    expect(status("alias")).toBe("set");
    expect(p.aliases["+jt"]).toBe("+jump");
    for (const l of r.lines)
      if (l.status === "skipped" || l.status === "kept" || l.status === "error")
        expect(l.note.length).toBeGreaterThan(3);
  });
  it("without keeping this game's keys, the config wins", () => {
    const r = importConfig(CSS_CFG, fresh(), { keepOwn: false });
    expect(r.prefs.binds.reload).toEqual(["KeyR"]);
    expect(r.prefs.binds.restart).toEqual([]);
    expect(r.prefs.binds.cpSave).toEqual([]);
  });
  it("an imported config survives the settings store's own load", () => {
    const r = importConfig(CSS_CFG, fresh());
    expect(parsePrefs(JSON.stringify(r.prefs)).binds).toEqual(r.prefs.binds);
  });
  it("bad values are errors, not silently set", () => {
    const r = importConfig("sensitivity abc\nfov_desired 500\nbind nokey +jump", fresh());
    expect(r.lines.map((l) => l.status)).toEqual(["error", "error", "error"]);
    expect(r.changed).toBe(false);
  });
  it("paste applies, prints a report, cfg_undo puts it back", () => {
    const { h, c } = host();
    c.paste('sensitivity 3\nbind mouse4 jump_toggle\nbind f "+jump;+duck"');
    expect(h.p.sensitivity).toBe(3);
    expect(h.p.binds.jumpToggle).toEqual(["Mouse4"]);
    expect(h.p.cmdBinds.KeyF).toBe("+jump; +duck");
    expect(h.lines[0].text).toMatch(/Imported 2 binds and 1 setting\. Every line was used/);
    c.run("cfg_undo");
    expect(h.p.sensitivity).toBe(2);
    expect(h.p.binds.jumpToggle).toEqual([]);
    expect(h.p.cmdBinds).toEqual({});
  });
});
