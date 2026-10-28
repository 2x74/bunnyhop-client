// The live game behind the chat commands (chat-commands.ts ChatGame): the player's keys, practice mode, styles and
// records. main.ts builds one and hands it to solo chat and room chat alike.

import { api } from "./api";
import type { ChatGame } from "./chat-commands";
import { getPB } from "./pb";
import { worldRecord } from "./shared-reads";
import type { Practice } from "./practice-mode/controller";
import type { RunSession } from "./session";
import { styleLabel } from "./styles";
import { formatTime } from "./timer";
import { keyLabel, prefs, type Action } from "./ui/settings";
import { trackName } from "./zones";

export function chatGame(o: { map: string; session: RunSession; practice: Practice }): ChatGame {
  const { map, session, practice } = o;
  return {
    key: (action) => {
      const code = prefs.get().binds[action as Action]?.[0];
      return code ? keyLabel(code) : null;
    },
    practice: (cmd, reply) => practice.command(cmd, reply),
    style: () => session.selectedStyle,
    setStyle: (id) => void session.setStyle(id),
    record: (kind, reply) => {
      const track = session.timer.track;
      const style = session.runStyle;
      const where = [track ? trackName(track) : null, style !== "autohop" ? styleLabel(style) : null].filter(Boolean).join(", ");
      const on = where ? ` (${where})` : "";
      if (kind === "pb") {
        const pb = getPB(map, style, track);
        return reply(pb ? `Your PB${on}: ${formatTime(pb.time)}` : `No PB yet${on}.`);
      }
      if (!api.available()) return reply("Leaderboards are offline.");
      worldRecord(map, style, track)
        .then((top) => {
          reply(top ? `WR${on}: ${formatTime(top.time)} by ${top.player.name}` : `No record yet${on}. Finish it to set one.`);
        })
        .catch(() => reply("Couldn't load the leaderboard."));
    },
  };
}
