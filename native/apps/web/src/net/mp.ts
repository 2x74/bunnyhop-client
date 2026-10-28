import { appHref } from "../platform/navigation";
import { setPlayerGlow } from "../player/cosmetics";
import { lastKnownMe } from "../api";
import { takeFreeCursor } from "../free-cursor";
import { openFeedback } from "../feedback/state";
import { openGiftDialog } from "../ui/gifting";
import { resolveGiftTarget } from "./gift-target";
// Multiplayer controller: one room per page (?map=<map>&server=<id>). main.ts creates it after the map loaded and
// calls four hooks; nothing here runs in solo play.
//
//   filterInput(sample)          neutral movement while spectating or typing in chat (view angles still follow)
//   afterTick(state, cmd, ev)    every sim tick: 20 Hz samples, a state batch every 10 ticks (10 Hz)
//   frame(camera, dt)            every rendered frame, after main.ts placed the camera: remote players, spectator
//                                camera (returns true when it moved the camera), HUD widgets
//   onAction(action)             bound actions (R while spectating = respawn)
//
// Your own movement is simulated locally exactly as in solo play; the room only relays it to the others, and your
// finished runs are still uploaded and verified (tagged ?room=<id> so the room can announce them).

import * as THREE from "three";
import { EVENT_JUMPED, EVENT_TELEPORTED, traceRay, type Core, type PlayerState } from "../core";
import type { Input, UserCmd } from "../input";
import type { RunSession } from "../session";
import type { Action } from "../ui/settings";
import { formatTime } from "../timer";
import { IN_WEAPON_COMMAND_MASK } from "../weapon-rules";
import { ATTACK_STAB } from "../viewmodel/events";
import { styleLabel } from "../styles";
import { tierLabel } from "../tiers";
import { trackName } from "../zones";
import { SpectatorCamera, type SpectatorMode, type SpectatorTarget } from "../viewer/cameras";
import { Banner, ChatBox, localLine, NumberMenu, Scoreboard, SpecBar, type ScoreRow } from "./hud";
import { RemotePlayers, remoteTime, slotColor } from "./players";
import { registerRoomActions, roomUrl, setRoomPresence } from "./presence";
import { copyLobbyInvite, lobbyInviteUrl } from "./lobby";
import { allowLeave, resumePlay } from "../play-lock";
import { spectateSlot } from "../social/spectate";
import { spectatorsOf } from "./spectators";
import {
  CLOSE,
  isExtend,
  SAMPLE_TICKS,
  SEND_TICKS,
  SF_CROUCHED,
  SF_SLASH,
  SF_STAB,
  SF_GROUNDED,
  SF_JUMPED,
  SF_TELEPORT,
  SF_INSPECT_SHIFT,
  styleAt,
  styleIndex,
  TIMER_FINISHED,
  TIMER_IDLE,
  TIMER_RUNNING,
  TIMER_START,
  type Announcement,
  type MapChange,
  type MapInfo,
  type NetSample,
  type Nomination,
  type PoolEntry,
  type RoomInfo,
  type RosterPlayer,
  type ServerMsg,
  type VoteView,
} from "./protocol";
import { RoomConnection, type RoomStatus } from "./room";
import { RaceUi } from "./race";
import type { GunImpacts } from "../viewmodel/guns/impacts";
import { announce, sfx } from "../audio";
import { celebrateRun, openCustomise, runRewards } from "../ui/unlocks";
import type { StaffRole } from "../progression";
import { staffBadgeOf, type PlayerMarks } from "../creators";
import { banner as notifyBanner } from "../notify";
import { runChatLine, suggestChat, type ChatContext, type ChatGame, type ReplyOpts } from "../chat-commands";

export interface MultiplayerInit {
  serverId: string;
  map: string;
  scene: THREE.Scene;
  core: Core;
  input: Input;
  session: RunSession;
  /** main.ts restart (resets the run onto a track's start). */
  restart: (track?: number) => void;
  /** The live game's gun impacts (main.ts GunPresenter): other players' shots draw their tracers with them. */
  impacts?: GunImpacts | null;
  /** The game behind the chat commands (chat-game.ts): keys for !help, practice, styles, records. */
  game?: ChatGame | null;
  /** Other players' models compile their shaders with it before they're drawn (net/players.ts). */
  renderer?: THREE.WebGLRenderer | null;
  /** ?spectate=<player id> (the friends list's Spectate, social/spectate.ts): watch them on arrival instead of spawning. */
  spectate?: string | null;
}

const HIDE_KEY = "bunnyhop:mp-hide";
const HOST_COMMANDS = "!map <map>, !mapvote, !extend, !kick <player>";

export class Multiplayer {
  readonly conn: RoomConnection;
  private players: RemotePlayers;
  private chat: ChatBox;
  private menu: NumberMenu;
  private board: Scoreboard;
  private banner: Banner;
  private specBar: SpecBar;
  /** !race (net/race.ts). */
  private race: RaceUi;
  private you = -1;
  private room: RoomInfo | null = null;
  private map: MapInfo | null = null;
  private nextMap: string | null = null;
  private change: MapChange | null = null;
  private vote: VoteView | null = null;
  private myVote: number | null = null;
  private voteHidden = -1;
  /** Last map-change countdown second beeped. */
  private lastCountdown = -1;
  private rtv = { count: 0, needed: 1 };
  /** Private lobbies: the host's slot (welcome room.host, then { t: "host" }). */
  private host: number | null = null;
  private nominations: Nomination[] = [];
  private pool: PoolEntry[] = [];
  // Local sampling
  private netTick = 1000;
  private jumped = false;
  /** SF_SLASH / SF_STAB since the last sample. */
  private attackFlags = 0;
  /** Inspect field for the next sample (protocol.ts SF_INSPECT_*): a start / next event, else the held level. */
  private inspectSig = 0;
  private inspectHeld = false;
  /** Weapon in hand (core.ts WEAPON_IDS), reported with every state batch; null = this build's core reports none. */
  private weapon: number | null = null;
  /** The gun in hand has its silencer on (core weaponReport().silencer; 0.0.12). */
  private silenced = false;
  private teleported = true;
  private lastSample: NetSample | null = null;
  // Spectating
  private spectating: number | null = null;
  private spec: SpectatorCamera | null = null;
  private specMode: SpectatorMode = "eye";
  /** The player to watch once the welcome lists them (MultiplayerInit.spectate); first welcome only. */
  private specOnJoin: string | null;
  private uiAt = 0;
  private navigating = false;
  private status: RoomStatus = "connecting";

  constructor(private o: MultiplayerInit) {
    this.specOnJoin = o.spectate ?? null;
    const hud = o.session.hud;
    const root = document.getElementById("hud")!;
    this.chat = new ChatBox(hud.chatEl);
    hud.els.chat.classList.remove("empty");
    this.menu = new NumberMenu(root);
    this.board = new Scoreboard(root);
    this.banner = new Banner(root);
    this.specBar = new SpecBar(root);
    this.race = new RaceUi(root, {
      menu: this.menu,
      banner: this.banner,
      others: () => this.others(),
      remoteTimer: (slot) => {
        const p = this.players.players.get(slot);
        const rt = p ? remoteTime(p, performance.now()) : null;
        return rt ? { status: rt.status, seconds: rt.seconds } : null;
      },
      toLocal: (t) => this.conn.toLocal(t),
      send: (text) => this.conn.send({ t: "chat", text }),
      reply: (text) => this.chat.add(localLine(text)),
      selectedStyle: () => o.session.selectedStyle,
      setStyle: (id) => o.session.setStyle(id),
      bonusTracks: () => o.session.bonusTracks(),
      restart: (track) => o.restart(track),
      spectating: () => this.spectating !== null,
      stopSpectating: () => this.stopSpectating(),
      changing: () => !!this.change || this.navigating,
    });
    this.players = new RemotePlayers(o.scene, () => this.you, (a, b) => traceRay(o.core, a, b, 0), o.impacts ?? null, o.renderer ?? null);
    this.players.hidden = localStorage.getItem(HIDE_KEY) === "1";
    this.chatCtx = { ...this.chatCtx, game: o.game ?? null };
    this.chat.onSend = (t) => this.onChat(t);
    this.chat.suggest = (t) => suggestChat(t, "room");
    this.chat.onClose = () => {
      o.input.releaseAll();
      o.input.recapture();
    };
    this.conn = new RoomConnection(o.serverId, () => o.session.selectedStyle, {
      message: (m) => this.onMessage(m),
      snapshot: (s, now) => {
        for (const b of s.blocks) if (b.slot !== this.you) this.players.feed(b.slot, b.meta, b.samples, now, b.weapon, b.silenced);
      },
      status: (s, detail) => this.onStatus(s, detail),
    });
    this.banner.set("Connecting…", o.serverId);
    document.addEventListener("keydown", (e) => this.keydown(e));
    document.addEventListener("keyup", (e) => {
      if (e.code === "Tab") this.board.show(false);
    });
    document.addEventListener("mousedown", (e) => {
      if (this.spectating === null || !o.input.pointerLocked) return;
      if (e.button === 0) this.cycleSpectate(1);
      else if (e.button === 2) this.cycleSpectate(-1);
    });
    document.addEventListener("pointerlockchange", () => {
      if (!o.input.locked) {
        this.chat.close();
        this.board.show(false);
      }
    });
    addEventListener("beforeunload", () => !this.navigating && this.conn.close(CLOSE.LEAVE));
    registerRoomActions({
      summary: () => this.summary(),
      spectate: () => this.openSpectateMenu(),
      canWatch: (id) => spectateSlot(this.roster(), id, this.you) !== null,
      watch: (id) => {
        const slot = spectateSlot(this.roster(), id, this.you);
        if (slot === null) return;
        this.startSpectate(slot);
        void resumePlay();
      },
      nominate: () => this.openNominateMenu(),
      race: () => this.race.pickPlayer(),
      invite: () => void this.invite(),
      changeMap: () => this.openNominateMenu(0, true),
      rtv: () => this.conn.send({ t: "rtv" }),
      leave: () => this.leave(),
      scoreboard: () => this.board.show(true),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Hooks for main.ts

  filterInput(cmd: UserCmd): UserCmd {
    // A race's countdown holds you on the start (the view still turns), like a race plugin's freeze.
    if (this.race.frozen) return { ...cmd, forwardmove: 0, sidemove: 0, buttons: cmd.buttons & IN_WEAPON_COMMAND_MASK };
    if (this.spectating === null && !this.chat.isOpen) return cmd;
    // Typing: no movement, but a weapon command typed in chat (!usp) still goes through.
    return { ...cmd, forwardmove: 0, sidemove: 0, buttons: this.spectating === null ? cmd.buttons & IN_WEAPON_COMMAND_MASK : 0 };
  }

  /** `weapon`: the active weapon id this tick (core weaponReport().active), null when the core reports none. */
  afterTick(s: PlayerState, cmd: UserCmd, events: number, weapon: number | null = null, silenced = false): void {
    if (this.spectating !== null) return;
    this.weapon = weapon;
    this.silenced = silenced;
    this.netTick++;
    if (events & EVENT_JUMPED) this.jumped = true;
    if (events & EVENT_TELEPORTED) this.teleported = true;
    if (this.netTick % SAMPLE_TICKS === 0) {
      const p = s.position;
      const v = s.velocity;
      const prev = this.lastSample;
      let flags = (s.grounded ? SF_GROUNDED : 0) | (s.crouched ? SF_CROUCHED : 0) | (this.jumped ? SF_JUMPED : 0) | this.attackFlags | ((this.inspectSig || (this.inspectHeld ? 3 : 0)) << SF_INSPECT_SHIFT);
      // Restarts reset the core without an event: catch any jump the movement can't explain.
      if (this.teleported || !prev || Math.hypot(p[0] - prev.x, p[1] - prev.y, p[2] - prev.z) > Math.hypot(v[0], v[1], v[2]) * 0.05 + 48) flags |= SF_TELEPORT;
      const smp: NetSample = { tick: this.netTick, x: p[0], y: p[1], z: p[2], vx: v[0], vy: v[1], vz: v[2], yaw: cmd.yaw, pitch: cmd.pitch, flags };
      this.lastSample = smp;
      this.jumped = this.teleported = false;
      this.attackFlags = 0;
      this.inspectSig = 0;
      this.conn.pushSample(smp);
    }
    if (this.netTick % SEND_TICKS === 0) {
      const t = this.o.session.timer;
      const timer = t.status === "running" ? TIMER_RUNNING : t.status === "finished" ? TIMER_FINISHED : t.inStart ? TIMER_START : TIMER_IDLE;
      this.conn.flushSamples({ style: styleIndex(this.o.session.runStyle), track: t.track, timer, timerTicks: t.ticks() }, this.weapon, this.silenced);
    }
  }

  frame(camera: THREE.PerspectiveCamera, dt: number): boolean {
    const now = performance.now();
    let moved = false;
    if (this.spectating !== null) {
      const st = this.players.stateOf(this.spectating);
      if (st) {
        this.spec ??= new SpectatorCamera({ trace: (a, b, r) => traceRay(this.o.core, a, b, r), chase: { distance: 110, followRate: 10 } });
        if (st.snapped) this.spec.snap();
        const target: SpectatorTarget = { pos: st.pos, vel: st.vel, viewZ: st.crouched ? 46 : 64, yaw: st.yaw, pitch: st.pitch, crouched: st.crouched, grounded: st.grounded };
        this.spec.update(camera, target, dt, this.specMode);
        moved = true;
      }
      this.players.inEye = this.specMode === "eye" ? this.spectating : null;
      // Their speed and timer in your HUD (P10: spectating looks like playing).
      const p = this.players.players.get(this.spectating);
      const rt = p ? remoteTime(p, now) : null;
      this.o.session.hud.setSpectated({
        speed: st ? Math.hypot(st.vel[0], st.vel[1]) : 0,
        status: rt?.status === TIMER_RUNNING ? "running" : rt?.status === TIMER_FINISHED ? "finished" : "idle",
        time: rt?.seconds ?? 0,
        inStart: rt?.status === TIMER_START,
      });
    } else this.players.inEye = null;
    this.players.frame(camera, dt, now);
    if (now - this.uiAt > 200) {
      this.uiAt = now;
      this.refreshUi(now);
    }
    return moved;
  }

  onAction(a: Action): boolean {
    if (this.spectating !== null && (a === "restart" || a === "restartMain" || a === "restartBonus")) {
      this.stopSpectating();
      return true;
    }
    if (this.spectating !== null && (a === "setStart" || a === "clearStart" || a === "cycleStyle" || a === "thirdPerson" || a === "attack" || a === "attack2" || a === "inspect")) return true;
    return false;
  }

  /** Spectating someone (main.ts hides the viewmodel). */
  get isSpectating(): boolean {
    return this.spectating !== null;
  }

  /** Your viewmodel swung (cosmetic): sent with the next sample so the others see the third-person slash / stab. */
  onAttack(kind: number): void {
    if (this.spectating !== null) return;
    this.attackFlags |= kind === ATTACK_STAB ? SF_STAB : SF_SLASH;
  }

  /** You fired a gun (the core's attack report): SF_SLASH on the next sample, a shot for the others (protocol.ts). */
  onShot(): void {
    if (this.spectating !== null) return;
    this.attackFlags |= SF_SLASH;
  }

  /** An inspect trick started (combo.ts SIG_START / SIG_NEXT): sent with the next sample (SF_INSPECT_*). */
  onInspect(sig: number): void {
    if (this.spectating !== null) return;
    // A start and a next in one 50 ms sample: the next wins (receivers pick the chain up at trick 1).
    this.inspectSig = Math.max(this.inspectSig, sig & 3);
  }

  /** The inspect key is held during an inspect (sent every sample as the SF_INSPECT held level). */
  setInspectHeld(h: boolean): void {
    this.inspectHeld = h;
  }

  // -------------------------------------------------------------------------------------------
  // Messages

  private name(slot: number): string {
    return this.players.players.get(slot)?.info.name ?? `#${slot}`;
  }

  private onStatus(s: RoomStatus, detail?: string): void {
    this.status = s;
    if (s === "reconnecting") this.banner.set("Connection lost", detail ?? "Reconnecting…");
    else if (s === "closed") {
      setRoomPresence(null);
      if (!this.navigating) this.banner.set("Disconnected", detail ? `${detail} · Esc → Servers` : "Esc → Servers to rejoin");
    } else if (s === "open" && !this.change) this.banner.set(null);
  }

  private readonly giftBatches = new Set<string>();

  private onMessage(m: ServerMsg): void {
    const now = performance.now();
    switch (m.t) {
      case "welcome": {
        this.you = m.you;
        this.room = m.room;
        this.host = m.room.host ?? null;
        this.map = m.map;
        this.nextMap = m.nextMap;
        this.vote = m.vote;
        this.myVote = m.myVote;
        this.rtv = m.rtv;
        this.nominations = m.nominations;
        this.pool = m.pool;
        this.players.clear();
        for (const p of m.players) this.players.upsert(p);
        const own = m.players.find(p => p.slot === this.you);
        if (own?.id === lastKnownMe()?.id) setPlayerGlow(own?.playerGlow ?? null);
        for (const [slot, meta] of Object.entries(m.metas)) this.players.setMeta(Number(slot), meta, now);
        for (const [slot, w] of Object.entries(m.weapons ?? {})) this.players.setWeapon(Number(slot), w);
        this.teleported = true;
        this.lastSample = null;
        if (this.spectating !== null) {
          // A reconnect starts you as a player again (slots may have changed): drop the old spectate target.
          this.spectating = null;
          document.body.classList.remove("mp-spectating");
          this.specBar.set(null);
          this.o.session.hud.setSpectated(null);
        }
        if (m.map.name !== this.o.map) return this.goto(m.map.name);
        setRoomPresence({ id: m.room.id, name: m.room.name });
        this.race.onState(m.race ?? null);
        this.race.connected();
        this.setChange(m.change);
        this.chat.add({ kind: "local", text: `Connected to ${m.room.name} (${m.players.length}/${m.room.maxPlayers}) · ${m.map.name}. Y chat · Tab scores · N spectate · type rtv / nominate / timeleft` });
        if (m.room.private) this.lobbyIntro(m.room.id);
        if (this.specOnJoin) {
          // Straight from the friends list: watching before the first sample goes out, so you never spawn.
          const slot = spectateSlot(m.players, this.specOnJoin, this.you);
          this.specOnJoin = null;
          if (slot !== null) this.startSpectate(slot);
          else this.chat.add({ kind: "local", text: "Your friend isn't on this server anymore." });
        }
        this.showVote();
        document.title = `${m.map.name} · ${m.room.name}`;
        break;
      }
      case "join":
        this.players.upsert(m.player);
        if (!m.quiet) {
          this.chat.add({ kind: "server", text: `${m.player.name} joined${m.player.rank ? ` (${m.player.rank.name})` : ""}.` });
          sfx("player_join");
        }
        break;
      case "leave":
        if (!m.quiet) this.chat.add({ kind: "server", text: `${m.name} left${m.reason ? ` (${m.reason})` : ""}.` });
        this.players.remove(m.slot);
        // The room drops spec targets on the one who left without a patch (rooms/room.ts leave): drop them here too.
        for (const p of this.players.players.values()) if (p.info.spec === m.slot) p.info = { ...p.info, spec: null };
        if (this.spectating === m.slot) this.cycleSpectate(1, true);
        break;
      case "player": {
        const p = this.players.players.get(m.slot);
        if (p) this.players.upsert({ ...p.info, ...m.patch });
        if (m.slot === this.you && p?.info.id === lastKnownMe()?.id && "playerGlow" in m.patch) setPlayerGlow(m.patch.playerGlow ?? null);
        if (m.patch.spec !== undefined && m.slot === this.spectating && m.patch.spec !== null) this.cycleSpectate(1, true);
        break;
      }
      case "gift": {
        if (this.giftBatches.has(m.batchId)) break;
        this.giftBatches.add(m.batchId);
        sfx("supporter_gift");
        const names = m.names.join(", ");
        this.chat.add({ kind: "server", text: m.count === 1 ? `${m.sender.name} gifted Supporter to ${names}!` : `${m.sender.name} gifted Supporter to ${m.count} players: ${names}${m.count > m.names.length ? " and more" : ""}!` });
        if (m.recipients.some((p) => p.id === this.players.players.get(this.you)?.info.id)) this.chat.add({ kind: "server", text: `You received Supporter from ${m.sender.name}. Enjoy your new perks!` });
        break;
      }
      case "chat": {
        if (m.slot !== undefined && m.slot !== this.you) sfx("chat");
        // The room stamps the speaker's role on the line; older servers only have the roster's admin flag.
        const role = m.role !== undefined ? m.role : m.slot !== undefined ? this.roleOf(m.slot) : null;
        this.chat.add({
          kind: m.kind,
          text: m.text,
          name: m.name,
          slotColor: m.slot !== undefined ? slotColor(m.slot) : undefined,
          rank: m.rank ?? null,
          // Staff / Verified / Creator / Booster / Supporter marks and the name colour stamped by the room on the line
          // (older servers: from the roster).
          ...(m.verified !== undefined || m.creator !== undefined
            ? { verified: m.verified, creator: m.creator, special: m.special, booster: m.booster, supporter: m.supporter, nameColor: m.nameColor, nameEffect: m.nameEffect, nameColor2: m.nameColor2, nameBadges: m.nameBadges, giftsSent: m.giftsSent, gifterColors: m.gifterColors, gifterAnimated: m.gifterAnimated }
            : m.slot !== undefined
              ? this.marksOf(m.slot)
              : {}),
          staff: m.staff !== undefined ? m.staff : staffBadgeOf(role),
        });
        break;
      }
      case "achievement":
        // The room recorded an achievement for you (Play with the Owner): the same celebration as a run's unlocks
        // (its sound with it; held until your run ends if you're mid-run).
        celebrateRun(runRewards({ achievements: [m.id] }), openCustomise);
        break;
      case "vote":
        // A new vote resets your choice; updates carry your own vote back.
        if (m.vote.id !== this.vote?.id) sfx("vote_open");
        else if (m.vote.counts.reduce((a, b) => a + b, 0) > (this.vote?.counts.reduce((a, b) => a + b, 0) ?? 0)) sfx("vote_tick");
        if (m.vote.id !== this.vote?.id) this.myVote = m.myVote ?? null;
        else if (m.myVote !== undefined && m.myVote !== null) this.myVote = m.myVote;
        this.vote = m.vote;
        this.showVote();
        break;
      case "voteEnd":
        this.vote = null;
        this.myVote = null;
        this.menu.hide("vote");
        break;
      case "rtv":
        this.rtv = { count: m.count, needed: m.needed };
        break;
      case "nominations":
        this.nominations = m.list;
        break;
      case "map":
        this.map = m.map;
        this.nextMap = m.nextMap;
        if (m.map.name !== this.o.map) this.goto(m.map.name);
        break;
      case "change":
        this.setChange(m.change);
        break;
      case "announce":
        this.announce(m.a);
        break;
      case "host": {
        const was = this.host === this.you;
        this.host = m.slot;
        // Not while a map change is under way: everyone reconnects then, and the host is back on the next map.
        if (m.slot === this.you && !was && !this.change && !this.navigating) this.chat.add({ kind: "local", text: `You're the host now: ${HOST_COMMANDS}.` });
        break;
      }
      case "race":
        this.race.onState(m.race);
        break;
      case "kicked":
        this.chat.add({ kind: "admin", text: `Disconnected: ${m.reason}` });
        this.banner.set("Disconnected", m.reason);
        break;
      case "error":
        this.chat.add({ kind: "private", text: m.message });
        this.banner.set(m.code === "full" ? "Server full" : m.code === "banned" ? "Banned" : m.code === "lobby_closed" ? "Lobby closed" : "Can't join", m.message);
        break;
    }
  }

  /** Staff / Verified / Creator / Server Booster / Supporter marks and the name colour of a slot from the roster (set by the room). */
  private marksOf(slot: number): PlayerMarks {
    const info = this.players.players.get(slot)?.info;
    return info
      ? { verified: info.verified, creator: info.creator, special: info.special, booster: info.booster, supporter: info.supporter, nameColor: info.nameColor, nameEffect: info.nameEffect, nameColor2: info.nameColor2, nameBadges: info.nameBadges, giftsSent: info.giftsSent, gifterColors: info.gifterColors, gifterAnimated: info.gifterAnimated, staff: info.staff !== undefined ? info.staff : staffBadgeOf(this.roleOf(slot)) }
      : {};
  }

  /** Staff role of a slot from the roster (`role` from the room; older servers: the admin flag). */
  private roleOf(slot: number): StaffRole | null {
    const info = this.players.players.get(slot)?.info;
    if (!info) return null;
    return info.role !== undefined ? info.role : info.admin ? "admin" : null;
  }

  private setChange(c: MapChange | null): void {
    if (c && (c.map !== this.change?.map || c.at !== this.change?.at)) sfx("map_change");
    this.change = c;
    this.lastCountdown = -1;
    if (!c) return;
    const at = this.conn.toLocal(c.at);
    const go = () => {
      if (this.change !== c) return;
      this.goto(c.map);
    };
    setTimeout(go, Math.max(0, at - Date.now()) + 250);
  }

  /** Reload onto the room's (new) map; the socket closes as a map change so nobody sees a leave/join. */
  private goto(map: string): void {
    if (this.navigating) return;
    this.navigating = true;
    this.banner.set(`Loading ${map}…`, this.room?.name ?? "", "change");
    this.conn.close(CLOSE.MAP_CHANGE);
    allowLeave(); // no "Leave site?" prompt for the room's own map change
    location.href = roomUrl(this.o.serverId, map, { spectate: this.specOnJoin });
  }

  private leave(): void {
    this.navigating = true;
    this.conn.close(CLOSE.LEAVE);
    setRoomPresence(null);
    const url = new URL(appHref());
    url.searchParams.delete("server");
    allowLeave();
    location.href = url.toString();
  }

  private announce(a: Announcement): void {
    const style = a.style !== "autohop" ? ` (${styleLabel(a.style)})` : "";
    const where = `${a.map}${a.track ? ` ${trackName(a.track)}` : ""}`;
    const time = formatTime(a.time);
    const rank = a.rank ? ` · rank #${a.rank}` : "";
    const prev = a.prev ? ` (was ${formatTime(a.prev)})` : "";
    const text =
      a.kind === "wr"
        ? `★ NEW WORLD RECORD by ${a.name} on ${where}: ${time}${style}${prev}`
        : a.kind === "sr"
          ? `${a.name} set a new server record on ${where}: ${time}${style}${rank}${prev}`
          : a.kind === "top10"
            ? `${a.name} is now top 10 on ${where}: ${time}${style}${rank}`
            : `${a.name} beat their PB on ${where}: ${time}${style}${rank}`;
    if (a.runId && (a.kind === "wr" || (a.slot === this.you && a.pb)))
      announce(a.kind === "wr" ? "wr" : "pb", a.runId, a.slot !== this.you);
    this.chat.add({ kind: "announce", tone: a.kind, text });
    // Records get a compact band across the top with a soft shine (someone else's record: quieter than your own
    // achievements); PBs / top 10s stay chat lines with a soft pop.
    if (a.kind === "wr" || a.kind === "sr")
      notifyBanner({ title: a.kind === "wr" ? "New world record" : "New server record", sub: `${a.name} on ${where}, ${time}${style}`, tone: a.kind, compact: true, sound: "shine", ms: 6000, key: `ann-${a.kind}-${a.map}-${a.time}` });
    else sfx("chat");
  }

  // -------------------------------------------------------------------------------------------
  // Chat + commands handled on this side: chat-commands.ts, the same registry as solo chat. Client commands (!r, !hide,
  // !setstart, ...) never reach the room; server commands and chat are sent as typed; !help, unknown commands and
  // practice attempts are answered here and sent `local` (the room logs them and adds staff help).

  private chatCtx: ChatContext = {
    where: "room",
    reply: (text, o?: ReplyOpts) => this.chat.add(localLine(text, o)),
    game: null, // (set in the constructor: o isn't there yet)
    restart: (track) => this.o.restart(track),
    restartBonus: () => this.o.session.restartBonus(this.chatCtx.reply),
    setStartPoint: () => this.o.session.setStartPoint(this.chatCtx.reply),
    clearStartPoint: () => this.o.session.clearStartPoint(this.chatCtx.reply),
    room: {
      spectating: () => this.spectating !== null,
      stopSpectating: () => this.stopSpectating(),
      spectate: (name) => this.spectateByName(name),
      hidePlayers: (toggle) => {
        this.players.hidden = toggle ? !this.players.hidden : false;
        localStorage.setItem(HIDE_KEY, this.players.hidden ? "1" : "0");
        this.chat.add({ kind: "local", text: this.players.hidden ? "Other players hidden (!hide to show)." : "Other players visible." });
      },
      toggleScores: () => this.board.show(!this.board.open),
      openNominateMenu: () => this.openNominateMenu(),
      invite: () => void this.invite(),
      race: (arg) => this.race.command(arg),
      gift: (arg) => {
        const result = resolveGiftTarget(arg, [...this.players.players.values()].map((p) => ({ id: p.info.id, name: p.info.name })));
        if (result.kind === "error") return this.chatCtx.reply(result.message);
        // Take over chat's released cursor before its deferred recapture runs.
        takeFreeCursor();
        openGiftDialog({ roomId: this.o.serverId, ...(result.kind === "player" ? { recipientId: result.id, recipientName: result.name } : {}) });
      },
      report: (arg) => {
        // Someone in this room by name (exact, else the only one it starts with); anyone else is looked up by the server.
        const q = arg.trim().toLowerCase();
        const here = [...this.players.players.values()].filter((p) => p.slot !== this.you).map((p) => ({ id: p.info.id, name: p.info.name }));
        const exact = here.filter((p) => p.name.toLowerCase() === q);
        const starts = here.filter((p) => p.name.toLowerCase().startsWith(q));
        const p = !q ? null : exact.length === 1 ? exact[0]! : !exact.length && starts.length === 1 ? starts[0]! : null;
        takeFreeCursor();
        openFeedback({ category: "report", ...(p ? { report: { id: p.id, name: p.name } } : q ? { report: { name: arg.trim() } } : {}) });
      },
    },
  };

  private onChat(text: string): void {
    const r = runChatLine(text, this.chatCtx);
    // "log": answered here (!help, an unknown command); the room only logs it (and adds staff help for staff).
    if (r !== "done") this.conn.send(r === "log" ? { t: "chat", text, local: true } : { t: "chat", text });
  }

  /** !spec <name>: the first other player whose name starts with it; no name opens the spectate menu. */
  private spectateByName(arg: string): void {
    if (!arg) return this.openSpectateMenu();
    const q = arg.toLowerCase();
    const p = [...this.players.players.values()].find((x) => x.slot !== this.you && x.info.name.toLowerCase().startsWith(q));
    if (p) this.startSpectate(p.slot);
    else this.chat.add({ kind: "local", text: `No player "${arg}".` });
  }

  // -------------------------------------------------------------------------------------------
  // Keys

  private keydown(e: KeyboardEvent): void {
    if (this.chat.isOpen || !this.o.input.locked || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Tab") {
      e.preventDefault();
      if (!e.repeat) {
        this.board.show(true);
        this.refreshUi(performance.now());
      }
      return;
    }
    if (e.repeat) return;
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
    if (digit && this.menu.open) {
      e.preventDefault();
      this.menu.key(Number(digit[1]));
      return;
    }
    // Bound actions keep their keys (rebinding Y / N / U to something else wins).
    if ((e.code === "KeyY" || e.code === "KeyU") && !this.o.input.isBound(e.code)) {
      e.preventDefault();
      this.o.input.releaseAll();
      this.chat.open();
      this.o.input.freeCursor();
      return;
    }
    if (e.code === "KeyN" && !this.o.input.isBound(e.code)) {
      e.preventDefault();
      if (this.menu.id.current === "spec") this.menu.hide();
      else this.openSpectateMenu();
      return;
    }
    if (this.spectating !== null && (e.code === "Space" || e.code === "KeyF")) {
      e.preventDefault();
      this.specMode = this.specMode === "eye" ? "chase" : "eye";
      this.spec?.snap();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Votes / menus

  private showVote(): void {
    const v = this.vote;
    if (!v || v.id === this.voteHidden) return;
    const first = this.menu.id.current !== "vote";
    const spec = {
      title: v.kind === "rtv" ? "Rock the vote: next map" : "Vote for the next map",
      items: v.options.map((o, i) => ({
        label: isExtend(o) ? `Extend map (+${o.minutes} min)` : o.map,
        detail: `${!isExtend(o) && o.tier ? `${tierLabel(o.tier)} · ` : ""}${v.counts[i] ?? 0}`,
        selected: this.myVote === i,
      })),
      footer: `${Math.max(0, Math.ceil((this.conn.toLocal(v.endsAt) - Date.now()) / 1000))} s left · ${v.counts.reduce((a, b) => a + b, 0)}/${this.players.players.size} voted`,
      exit: "Hide",
      onPick: (i: number) => {
        this.myVote = i;
        this.conn.send({ t: "vote", option: i });
        this.showVote();
      },
      onExit: () => (this.voteHidden = v.id),
    };
    if (first) this.menu.show("vote", spec);
    else this.menu.update("vote", spec);
  }

  /** Everyone in the room, you included (RosterPlayer: slot, id, spec). */
  private roster(): RosterPlayer[] {
    return [...this.players.players.values()].map((p) => p.info);
  }

  private others(): { slot: number; name: string; detail: string }[] {
    const now = performance.now();
    return [...this.players.players.values()]
      .filter((p) => p.slot !== this.you && p.info.spec === null)
      .map((p) => {
        const rt = remoteTime(p, now);
        return { slot: p.slot, name: p.info.name, detail: rt && (rt.status === TIMER_RUNNING || rt.status === TIMER_FINISHED) ? formatTime(rt.seconds) : "" };
      });
  }

  private openSpectateMenu(): void {
    const list = this.others().slice(0, 8);
    if (!list.length) {
      this.chat.add({ kind: "local", text: "Nobody to spectate yet." });
      return;
    }
    const items = list.map((p) => ({ label: p.name, detail: p.detail, selected: p.slot === this.spectating }));
    if (this.spectating !== null) items.push({ label: "Stop spectating (respawn)", detail: "", selected: false });
    this.menu.show("spec", {
      title: "Spectate",
      items,
      footer: "Mouse 1 and 2 switch players. Space changes the camera.",
      onPick: (i) => {
        this.menu.hide();
        if (i < list.length) this.startSpectate(list[i].slot);
        else this.stopSpectating();
      },
    });
  }

  /** Once per lobby per tab (every map change reconnects): what a private lobby is, and the host's commands. */
  private lobbyIntro(id: string): void {
    const key = `bunnyhop:lobby-intro:${id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    if (this.host === this.you) this.chat.add({ kind: "local", text: `Your private lobby. Invite friends with !invite (copies the link) or Esc → Server. As host: ${HOST_COMMANDS}.` });
    else this.chat.add({ kind: "local", text: "Private lobby. !invite copies the invite link." });
  }

  private async invite(): Promise<void> {
    if (!this.room?.private) return void this.chat.add({ kind: "local", text: "Only in private lobbies: Play online → Create private lobby." });
    const ok = await copyLobbyInvite(this.room.id);
    this.chat.add({ kind: "local", text: ok ? "Invite link copied. Send it to your friends." : `Invite link: ${lobbyInviteUrl(this.room.id)}` });
  }

  /** `host`: the lobby host's "Change lobby map" (sends !map), over the whole pool; else nominations. */
  private openNominateMenu(page = 0, host = false): void {
    const recentlyBlocked = new Set(host ? [this.map?.name] : [this.map?.name, ...this.nominations.map((n) => n.map)]);
    const pool = this.pool.filter((p) => !recentlyBlocked.has(p.name));
    const per = 7;
    const pages = Math.max(1, Math.ceil(pool.length / per));
    const slice = pool.slice(page * per, page * per + per);
    const items = slice.map((p) => ({ label: p.name, detail: p.tier ? tierLabel(p.tier) : "" }));
    if (pages > 1) items.push({ label: "More…", detail: `${page + 1}/${pages}` });
    this.menu.show("nominate", {
      title: host ? "Change lobby map" : "Nominate a map",
      items,
      footer: !host && this.nominations.length ? `Nominated: ${this.nominations.map((n) => n.map).join(", ")}` : host ? "Or type !map <name>" : undefined,
      onPick: (i) => {
        if (i >= slice.length) return this.openNominateMenu((page + 1) % pages, host);
        this.menu.hide();
        if (host) this.conn.send({ t: "chat", text: `!map ${slice[i].name}` });
        else this.conn.send({ t: "nominate", map: slice[i].name });
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Spectating

  private startSpectate(slot: number): void {
    if (slot === this.you || !this.players.players.has(slot)) return;
    const was = this.spectating;
    this.spectating = slot;
    document.body.classList.add("mp-spectating");
    this.specMode = "eye";
    this.spec?.snap();
    this.conn.send({ t: "spec", target: slot });
    if (was === null) {
      // Like joining spectators in CS:S: your run is reset; you respawn in the start zone when you're back.
      this.o.restart(0);
      this.o.input.releaseAll();
    }
    this.chat.add({ kind: "local", text: `Spectating ${this.name(slot)}. Mouse 1 and 2 switch players, Space changes the camera, R respawns you.` });
  }

  private cycleSpectate(dir: number, forced = false): void {
    const list = this.others().map((p) => p.slot);
    if (!list.length) {
      if (forced || this.spectating !== null) this.stopSpectating();
      return;
    }
    const i = this.spectating === null ? -1 : list.indexOf(this.spectating);
    const next = list[(i + dir + list.length) % list.length] ?? list[0];
    if (next !== this.spectating) this.startSpectate(next);
  }

  private stopSpectating(): void {
    if (this.spectating === null) return;
    this.spectating = null;
    document.body.classList.remove("mp-spectating");
    this.players.inEye = null;
    this.conn.send({ t: "spec", target: null });
    this.teleported = true;
    this.lastSample = null;
    this.specBar.set(null);
    this.o.session.hud.setSpectated(null);
    this.o.restart(0);
  }

  // -------------------------------------------------------------------------------------------
  // Periodic UI (5 Hz)

  private timeLeft(): string {
    if (this.change) return `changing to ${this.change.map}`;
    if (!this.map) return "";
    const ms = this.conn.toLocal(this.map.endsAt) - Date.now();
    if (ms <= 0) return "last round";
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
  }

  private summary() {
    return { id: this.o.serverId, name: this.room?.name ?? this.o.serverId, map: this.map?.name ?? this.o.map, tier: this.map?.tier ?? null, players: this.players.players.size, max: this.room?.maxPlayers ?? 0, timeLeft: this.timeLeft(), rtv: this.rtv, spectating: this.spectating !== null, status: this.status, lobby: !!this.room?.private, host: !!this.room?.private && this.host === this.you };
  }

  private refreshUi(now: number): void {
    // Map change countdown.
    if (this.change && !this.navigating) {
      const s = Math.max(0, Math.ceil((this.conn.toLocal(this.change.at) - Date.now()) / 1000));
      // Countdown beeps for the last three seconds.
      if (s !== this.lastCountdown && s <= 3) sfx(s === 0 ? "countdown_go" : "countdown_tick");
      this.lastCountdown = s;
      this.banner.set(`Changing map to ${this.change.map} in ${s}…`, this.change.tier ? `Tier ${this.change.tier}` : (this.room?.name ?? ""), "change");
    }
    if (this.vote && this.menu.id.current === "vote") this.showVote();
    this.race.refresh();
    // Spectator bar.
    if (this.spectating !== null) {
      const p = this.players.players.get(this.spectating);
      const st = p?.has ? p.state : null;
      const rt = p ? remoteTime(p, now) : null;
      this.specBar.set(p && st ? { name: p.info.name, color: slotColor(p.slot) } : { name: this.name(this.spectating), color: "#fff", waiting: true });
    }
    // Spectator list (HUD element "spectators"): who watches you, or whom you watch.
    this.o.session.hud.setSpectators(this.status === "open" ? spectatorsOf(this.roster(), this.you, this.spectating) : []);
    if (this.board.open) this.renderBoard(now);
  }

  private renderBoard(now: number): void {
    const rows: ScoreRow[] = [];
    const sess = this.o.session;
    for (const p of this.players.players.values()) {
      const you = p.slot === this.you;
      const style = you ? sess.runStyle : (styleAt(p.meta?.style ?? -1) ?? p.info.style);
      let status = "—";
      let kind: ScoreRow["statusKind"] = "idle";
      if (p.info.spec !== null || (you && this.spectating !== null)) {
        const target = you ? this.spectating : p.info.spec;
        status = `SPEC → ${target !== null ? this.name(target) : "?"}`;
        kind = "spec";
      } else if (you) {
        const t = sess.timer;
        if (t.status === "running") (status = formatTime(t.time())), (kind = "running");
        else if (t.status === "finished") (status = formatTime(t.time())), (kind = "finished");
        else if (t.inStart) status = "start zone";
      } else {
        const rt = remoteTime(p, now);
        if (rt?.status === TIMER_RUNNING) (status = formatTime(rt.seconds)), (kind = "running");
        else if (rt?.status === TIMER_FINISHED) (status = formatTime(rt.seconds)), (kind = "finished");
        else if (rt?.status === TIMER_START) status = "start zone";
      }
      rows.push({
        slot: p.slot,
        you,
        name: p.info.name,
        color: slotColor(p.slot),
        rank: p.info.rank,
        role: this.roleOf(p.slot),
        ...this.marksOf(p.slot),
        style,
        status,
        statusKind: kind,
        pb: p.info.pb[style] ?? null,
        ping: you ? Math.round(this.conn.rtt) || null : (p.meta?.ping ?? null),
        host: !!this.room?.private && p.slot === this.host,
        country: p.info.country ?? null,
      });
    }
    rows.sort((a, b) => (a.pb ?? Infinity) - (b.pb ?? Infinity) || a.name.localeCompare(b.name));
    this.board.render(
      { room: this.room?.name ?? this.o.serverId, map: this.map?.name ?? this.o.map, tier: this.map?.tier ?? null, timeLeft: this.timeLeft(), players: this.players.players.size, max: this.room?.maxPlayers ?? 0, nextMap: this.change?.map ?? this.nextMap, spectating: this.spectating !== null },
      rows,
    );
  }
}

/** main.ts entry: only called with ?server=<id>. */
export function startMultiplayer(o: MultiplayerInit): Multiplayer {
  const mp = new Multiplayer(o);
  if (import.meta.env.DEV) Object.assign(window, { __mp: mp });
  return mp;
}
