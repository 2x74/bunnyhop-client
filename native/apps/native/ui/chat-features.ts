// Chat commands for game features the web registers from its gameplay modules (paint/commands.ts, measure/index.ts,
// movement-stats/index.ts, triggers/index.ts, hud/strafe-trainer.ts). Same names, aliases and help as the web; the
// host does the work. Each one is registered only once the host says it has the feature, so !help lists what exists.
//
// Host contract: state `capabilities: string[]` names the features ("paint", "measure", "longjump", "movementStats",
// "triggerMenu"). The commands send {type:"chatAction", action, ...} (chat-service.ts ChatAction); the host answers in
// chat itself (a measured distance, "Your paint has been cleared.").

import { registerChatCommand, type ChatCommand, type ChatContext } from "../../web/src/chat-commands";
import { trainerCommand } from "../../web/src/hud/strafe-trainer";
import { send, state } from "./bridge";
import type { ChatAction } from "./chat-service";

const emit = (action: ChatAction) => send(action as unknown as Parameters<typeof send>[0]);
const MAX_CAPABILITIES = 64;
const registered = new Map<string, () => void>();

type MovementStat = "offsets" | "fjt" | "lj";

function onOff(name: string, arg: string, ctx: ChatContext): boolean | undefined | null {
  const value = arg.toLowerCase();
  if (!value) return undefined;
  if (value === "on" || value === "off") return value === "on";
  ctx.reply(`Usage: !${name} [on|off]`);
  return null;
}

function movementStat(name: MovementStat, aliases: string[], help: string): ChatCommand {
  return {
    name,
    aliases,
    help,
    group: "more",
    where: "both",
    args: "[on|off]",
    run: (ctx, arg) => {
      const value = onOff(name, arg, ctx);
      if (value === null) return;
      emit({ type: "chatAction", action: "movementStat", stat: name, ...(value === undefined ? {} : { on: value }) });
    },
  };
}

/** The commands each host capability brings (web names, aliases and help). */
const FEATURES: Record<string, () => ChatCommand[]> = {
  paint: () => [
    {
      name: "paint",
      help: "place a private paint mark",
      group: "more",
      key: "paint",
      where: "both",
      run: () => emit({ type: "chatAction", action: "paint" }),
    },
    {
      name: "clearpaint",
      help: "clear your paint",
      group: "more",
      key: "clearPaint",
      where: "both",
      run: () => emit({ type: "chatAction", action: "clearPaint" }),
    },
    {
      name: "paintoptions",
      aliases: ["paintcolour", "paintcolor", "paintsize"],
      help: "paint colour and size",
      group: "more",
      where: "both",
      run: () => emit({ type: "chatAction", action: "paintOptions" }),
    },
  ],
  measure: () => [
    {
      name: "measure",
      aliases: ["distance"],
      args: "[clear]",
      help: "measure between two aimed points",
      group: "more",
      key: "measurePoint",
      where: "both",
      run: (ctx, arg) => {
        if (arg.toLowerCase() === "clear") emit({ type: "chatAction", action: "clearMeasure" });
        else if (arg) ctx.reply("Usage: !measure [clear]. Aim at a surface and use it twice to measure a gap.");
        else emit({ type: "chatAction", action: "measure" });
      },
    },
    {
      name: "clearmeasure",
      help: "clear your measurement",
      group: "more",
      key: "clearMeasure",
      where: "both",
      run: () => emit({ type: "chatAction", action: "clearMeasure" }),
    },
  ],
  longjump: () => [
    {
      name: "ljlast",
      help: "view or share your last jump",
      group: "more",
      where: "both",
      key: "lastLj",
      run: () => emit({ type: "chatAction", action: "lastLj" }),
    },
  ],
  movementStats: () => [
    movementStat("offsets", ["offset"], "strafe offsets"),
    movementStat("fjt", ["jumptick", "jt"], "first jump tick"),
    movementStat("lj", ["ljstats", "longjump"], "longjump stats"),
  ],
  triggerMenu: () => [
    {
      name: "triggers",
      aliases: ["triggermenu"],
      help: "pick which triggers show",
      about: "a menu of what !showtriggers and !showclips draw.",
      group: "more",
      panelOnly: true,
      where: "both",
      run: () => emit({ type: "chatAction", action: "triggerMenu" }),
    },
  ],
};

/** The host's capabilities from a state message, or null when it doesn't list them. */
function readCapabilities(value: unknown): Set<string> | null {
  if (!value || typeof value !== "object") return null;
  const list = (value as Record<string, unknown>).capabilities;
  if (!Array.isArray(list)) return null;
  return new Set(list.slice(0, MAX_CAPABILITIES).filter((name): name is string => typeof name === "string"));
}

/** Registers or removes the feature commands to match what the host has. Call with every host state. */
export function applyChatFeatures(value: unknown): void {
  const capabilities = readCapabilities(value);
  if (!capabilities) return;
  for (const [feature, commands] of Object.entries(FEATURES)) {
    const has = capabilities.has(feature);
    const unregister = registered.get(feature);
    if (has && !unregister) {
      const removers = commands().map((command) => registerChatCommand(command));
      registered.set(feature, () => {
        for (const remove of removers) remove();
      });
    } else if (!has && unregister) {
      unregister();
      registered.delete(feature);
    }
  }
}

/** !strafetrainer / !st: the native trainer setting exists, so this one is always there. Returns the unregister. */
export function registerStrafeTrainerCommand(): () => void {
  return registerChatCommand(
    trainerCommand(
      () => state.settings.strafeTrainer,
      (on) => {
        state.settings.strafeTrainer = on;
        send({ type: "settings", patch: { strafeTrainer: on } });
      },
    ),
  );
}
