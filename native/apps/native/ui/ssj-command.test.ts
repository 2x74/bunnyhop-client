import { expect, test } from "bun:test";
import { ssjCommand } from "./chat-service";

// The website's !ssj (ssj/index.ts): the same words, limits and replies.
test("!ssj opens the settings, switches the chat line or sets the least gain", () => {
  expect(ssjCommand("")).toEqual({ open: true });
  expect(ssjCommand(" OFF ")).toEqual({
    action: { type: "chatAction", action: "ssjChat", on: false },
    reply: "Jump stats off in chat.",
  });
  expect(ssjCommand("on")).toMatchObject({ action: { on: true }, reply: "Jump stats on in chat." });
  expect(ssjCommand("80%")).toEqual({
    action: { type: "chatAction", action: "ssjChat", on: true, minGain: 80 },
    reply: "Jump stats in chat: only jumps with 80% gain or more.",
  });
  expect(ssjCommand("72.6")).toMatchObject({ action: { minGain: 73 } });
  expect(ssjCommand("0")).toMatchObject({ action: { on: true, minGain: 0 }, reply: "Jump stats in chat: every jump." });
  for (const bad of ["101", "-5", "abc", "8o", "1e2"])
    expect(ssjCommand(bad)).toEqual({ error: "Usage: !ssj [on|off|gain %], e.g. !ssj 80" });
});
