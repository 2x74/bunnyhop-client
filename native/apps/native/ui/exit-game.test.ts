import { describe, expect, it } from "bun:test";
import { exitGame, isQuitCommand, uploadingStatus, type ExitGameDeps } from "./exit-game";

function deps(o: { running?: boolean; answer?: boolean; uploadingFor?: number } = {}) {
  const log: string[] = [];
  let clock = 0;
  const d: ExitGameDeps = {
    runInProgress: () => o.running ?? false,
    uploading: () => clock < (o.uploadingFor ?? 0),
    confirm: async () => (log.push("ask"), o.answer ?? true),
    quit: () => void log.push(`quit@${clock}`),
    sleep: async (ms) => void (clock += ms),
  };
  return { d, log };
}

describe("Exit game", () => {
  it("quits at once from the main menu, even with a run going", async () => {
    const { d, log } = deps({ running: true });
    expect(await exitGame(d, false)).toBe(true);
    expect(log).toEqual(["quit@0"]);
  });
  it("asks once in the pause menu while a run is going", async () => {
    const yes = deps({ running: true, answer: true });
    await exitGame(yes.d, true);
    expect(yes.log).toEqual(["ask", "quit@0"]);
    const no = deps({ running: true, answer: false });
    expect(await exitGame(no.d, true)).toBe(false);
    expect(no.log).toEqual(["ask"]);
    const idle = deps({ running: false });
    await exitGame(idle.d, true);
    expect(idle.log).toEqual(["quit@0"]);
  });
  it("lets a finished run's upload finish, for a moment at most", async () => {
    const quick = deps({ uploadingFor: 300 });
    await exitGame(quick.d, false);
    expect(quick.log).toEqual(["quit@300"]);
    const stuck = deps({ uploadingFor: 60_000 });
    await exitGame(stuck.d, false);
    expect(stuck.log).toEqual(["quit@1500"]);
  });
  it("knows the upload statuses and the console's quit", () => {
    expect(["checking", "uploading"].every(uploadingStatus)).toBe(true);
    expect(["pending", "verified", "kept", "error", null].some(uploadingStatus)).toBe(false);
    expect(["quit", "exit", " QUIT "].every(isQuitCommand)).toBe(true);
    expect(["disconnect", "quit now", "exit 1", "echo quit"].some(isQuitCommand)).toBe(false);
  });
});
