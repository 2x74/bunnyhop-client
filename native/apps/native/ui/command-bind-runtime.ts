import { mixesMoveAndTurn, MOVE_TURN_REFUSAL, runPress, runRelease } from "../../web/src/console/bind-run";
import { actionForCommand } from "../../web/src/console/names";
import type { Action } from "../../web/src/ui/settings";

export interface CommandOperation {
  kind: "hold" | "unhold" | "once" | "press";
  code: string;
  step: number;
  action?: Action;
  own?: boolean;
  command?: string;
}

/** Expand the web syntax once; native applies holds at command boundaries without a WebView round trip. */
export function commandBindPlan(
  code: string,
  down: boolean,
  command: string,
  aliases: Readonly<Record<string, string>>,
): { ops: CommandOperation[]; error?: string } {
  if (down && mixesMoveAndTurn(command, aliases)) return { ops: [], error: MOVE_TURN_REFUSAL };
  const ops: CommandOperation[] = [];
  let step = 0,
    error: string | undefined;
  const handlers = {
    hold: (action: Action, own: boolean) => ops.push({ kind: "hold", code, step, action, own }),
    unhold: (action: Action, own: boolean) => ops.push({ kind: "unhold", code, step, action, own }),
    once: (text: string) => {
      const action = actionForCommand(text);
      const native = new Set<Action>([
        "slot1",
        "slot2",
        "slot3",
        "lastWeapon",
        "nextWeapon",
        "prevWeapon",
        "drop",
        "reload",
        "inspect",
        "jumpToggle",
      ]);
      if (action && native.has(action)) ops.push({ kind: "press", code, step, action });
      else ops.push({ kind: "once", code, step, command: text });
    },
    error: (text: string) => {
      error = text;
    },
    wait: () => void step++,
  };
  if (down) runPress(command, aliases, handlers);
  else runRelease(command, aliases, handlers);
  return { ops, error };
}
