// Chat in solo play: the room chat box (net/hud.ts ChatBox, in the HUD's chat element) for typing commands. Y (or U)
// opens it like in a room (with the cursor free to scroll it: free-cursor.ts), Enter runs the line through
// chat-commands.ts, Esc closes. Nothing is sent anywhere: commands answer as local lines, room-only ones say so, and
// plain chat says it goes nowhere. main.ts creates it in solo play (rooms have net/mp.ts) and runs every tick's input
// through filterInput.

import { ChatBox, localLine } from "./net/hud";
import { runChatLine, suggestChat, type ChatContext, type ChatGame, type ReplyOpts } from "./chat-commands";
import type { Input, UserCmd } from "./input";
import type { RunSession } from "./session";
import { IN_WEAPON_COMMAND_MASK } from "./weapon-rules";

export interface SoloChatInit {
  input: Input;
  session: RunSession;
  /** main.ts restart (resets the run onto a track's start). */
  restart: (track?: number) => void;
  /** Whether Y may open the chat now (not over the replay viewer). */
  enabled: () => boolean;
  /** The game behind the commands (chat-game.ts): keys for !help, practice, styles, records. */
  game: ChatGame;
}

export class SoloChat {
  readonly chat: ChatBox;
  private ctx: ChatContext;

  constructor(o: SoloChatInit) {
    const hud = o.session.hud;
    this.chat = new ChatBox(hud.chatEl, "!help for commands  (Enter to run, Esc to close)");
    hud.els.chat.classList.remove("empty");
    const reply = (text: string, ro?: ReplyOpts) => this.chat.add(localLine(text, ro));
    this.ctx = {
      where: "solo",
      reply,
      game: o.game,
      restart: (track) => o.restart(track),
      restartBonus: () => o.session.restartBonus(reply),
      setStartPoint: () => o.session.setStartPoint(reply),
      clearStartPoint: () => o.session.clearStartPoint(reply),
      room: null,
    };
    this.chat.onSend = (t) => runChatLine(t, this.ctx);
    this.chat.onClose = () => {
      o.input.releaseAll();
      o.input.recapture();
    };
    this.chat.suggest = (t) => suggestChat(t, "solo");
    document.addEventListener("keydown", (e) => {
      if (this.chat.isOpen || !o.input.locked || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !o.enabled()) return;
      // Same keys as rooms; a bind on Y / U wins.
      if ((e.code === "KeyY" || e.code === "KeyU") && !o.input.isBound(e.code)) {
        e.preventDefault();
        o.input.releaseAll();
        this.chat.open();
        o.input.freeCursor();
      }
    });
    document.addEventListener("pointerlockchange", () => {
      if (!o.input.locked) this.chat.close();
    });
  }

  /** No movement or buttons while typing (view angles still follow), as in rooms; a weapon command (!usp) goes through. */
  filterInput(cmd: UserCmd): UserCmd {
    if (!this.chat.isOpen) return cmd;
    return { ...cmd, forwardmove: 0, sidemove: 0, buttons: cmd.buttons & IN_WEAPON_COMMAND_MASK };
  }
}
