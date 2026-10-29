// Account -> Edit avatar: the website's avatar editor (/avatar, avatar/main.ts) inside the menu, saving to the account
// the game is signed in to. Same choices, same rules: signed in, what the account owns (GET /me/cosmetics) and it opens
// on the saved avatar or the default; without an account, the free items and a draft kept here, and Download still
// works. The pictures come from the host (avatar-host.ts): the big preview, the 256 px WebP that gets saved and the
// pickers' thumbnails. Map backdrops aren't drawn natively; a saved one shows as the website's plain fallback.
import "../../web/src/avatar/avatar.css";
import "./avatar-editor.css";
import { api, ApiError, type User } from "../../web/src/api";
import { accountChanged, me } from "../../web/src/ui/account-state";
import { dismissOutside } from "../../web/src/ui/dismiss";
import { h } from "../../web/src/ui/dom";
import { cosmetic } from "../../web/src/progression";
import {
  AVATAR_PX,
  BACKDROPS,
  cleanAvatar,
  defaultAvatar,
  defaultBg,
  FRAMES,
  GUN_IDS,
  packAvatar,
  POSES,
  type AvatarSpec,
} from "../../web/src/avatar/spec";
import { getLoadout, getOutfit } from "../../web/src/player/cosmetics";
import {
  choicesOf,
  currentOf,
  FOCUS,
  GUN_NAMES,
  hairOptions,
  handForPose,
  options,
  ownedOnly,
  pickPatch,
  SLOT_NAME,
  thumbSpec,
  wearing,
  type Options,
  type Slot,
} from "./avatar-choices";
import {
  backdropOf,
  closeAvatarRenderer,
  pictureError,
  renderAvatar,
  renderSpec,
  type AvatarFocus,
} from "./avatar-host";

const DRAFT_KEY = "bunnyhop:avatar-draft";
const THUMB_PX = 168;
const MAX_PREVIEW_PX = 1024;
const SMALL_DELAY_MS = 260;
const DOWNLOAD_SIZES = [512, 1024, 2048];
const DEFAULT_DOWNLOAD_PX = 1024;
// Drag across the preview to turn the bunny: degrees per preview width (main.ts).
const TURN_PER_WIDTH = 300;
const MIN_DRAG_WIDTH = 200;
// "Zoom" reads closer-to-the-right: the slider shows 2.3 - zoom (main.ts).
const ZOOM_FLIP = 2.3;

type Child = Node | string | null | false;

/** Rendered thumbnails by spec, kept while the menu runs (they don't change with the account). */
const thumbs = new Map<string, Promise<string>>();

function thumb(spec: AvatarSpec, focus?: AvatarFocus): Promise<string> {
  const key = packAvatar(spec) + (focus ?? "");
  let picture = thumbs.get(key);
  if (!picture) {
    picture = renderAvatar({
      output: "preview",
      size: THUMB_PX,
      focus,
      spec: renderSpec(spec),
      backdrop: { kind: "clear" },
    }).then((p) => ("png" in p ? p.png : ""));
    thumbs.set(key, picture);
    // A failed thumbnail is asked for again next time.
    void picture.then((png) => {
      if (!png) thumbs.delete(key);
    });
  }
  return picture;
}

function thumbImg(spec: AvatarSpec, cls: string, focus?: AvatarFocus): HTMLImageElement {
  const img = h(`img.${cls}`, { alt: "", width: THUMB_PX / 2, height: THUMB_PX / 2, draggable: "false" });
  void thumb(spec, focus).then((png) => {
    if (png) img.src = png;
  });
  return img;
}

function section(title: string, current: string | null, ...body: Child[]): HTMLElement {
  return h("div.av-sec", null, h("h2", null, title, current ? h("span.av-cur", null, current) : null), ...body);
}

/** A plain list of choices (the pause menu's rail: amber bar on the chosen one). */
function list<T extends string>(
  items: readonly { id: T; name: string }[],
  current: T | null,
  pick: (id: T) => void,
  cls = "",
): HTMLElement {
  const options = items.map((it) =>
    h(
      "button.av-opt",
      { type: "button", role: "option", "aria-selected": String(it.id === current), onclick: () => pick(it.id) },
      it.name,
    ),
  );
  return h("div.av-list", { class: cls, role: "listbox" }, ...options);
}

interface Swatch {
  id: string;
  name: string;
  color: string;
  color2?: string;
}

function swatches(items: Swatch[], current: string, pick: (id: string) => void, hover: (id: string | null) => void) {
  const buttons = items.map((it) =>
    h("button.av-sw", {
      type: "button",
      role: "option",
      title: it.name,
      "aria-label": it.name,
      "aria-selected": String(it.id === current),
      style: `--sw:${it.color};--sw2:${it.color2 ?? it.color}`,
      onpointerenter: () => hover(it.id),
      onclick: () => pick(it.id),
    }),
  );
  return h("div.av-swatches", { role: "listbox", onpointerleave: () => hover(null) }, ...buttons);
}

function slider(label: string, value: number, range: [number, number, number], set: (v: number) => void) {
  const [min, max, step] = range;
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  input.addEventListener("input", () => set(Number(input.value)));
  return h("label.av-slider", null, h("span", null, label), input);
}

function backdropName(bg: string): string | null {
  if (bg === "clear") return "Clear";
  if (bg.startsWith("outfit:")) return "Colourway";
  if (bg.startsWith("map:")) return `${bg.slice(4)} (website only)`;
  if (bg.startsWith("#")) return bg;
  return BACKDROPS.find((b) => b.id === bg)?.name ?? null;
}

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Couldn't reach the server.";
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

class AvatarEditor {
  private spec: AvatarSpec = defaultAvatar("guest", null);
  /** A choice being hovered (a picker tile, a backdrop swatch): on the big preview, not saved. */
  private preview: Partial<AvatarSpec> | null = null;
  private unlocked: ReadonlySet<string> = new Set();
  private user: User | null = null;
  private signedIn = false;
  private custom = false;
  private picking: Slot | null = null;
  private drawSerial = 0;
  private drawQueued = false;
  private smallTimer = 0;
  private drag: { x: number; turn: number } | null = null;

  readonly dialog = h("dialog.av-dialog", { "aria-label": "Avatar" });
  private readonly view = h("div.av-view", { "aria-label": "Your bunny. Drag to turn it." });
  private readonly picture = h("img.av-picture", { alt: "", draggable: "false" });
  private readonly round = h("img.av-round", { alt: "", width: 72, height: 72 });
  private readonly rowImg = h("img", { alt: "", width: 24, height: 24 });
  private readonly rowName = h("span", null, "you");
  private readonly controls = h("section.av-controls", { "aria-label": "Customize" });
  private readonly status = h("p.av-status", { role: "status" });
  private readonly save = h("button.btn.primary", { type: "button" }, "Use as my avatar");
  private readonly reset = h("button.av-link.av-reset", { type: "button", hidden: true }, "Go back to the default");
  private readonly size = h("select", { "aria-label": "PNG size" });
  private readonly discordBox = h("input", { type: "checkbox" });
  private readonly discord = h(
    "label.av-discord",
    { hidden: true },
    this.discordBox,
    " Show my Discord picture instead",
  );

  constructor() {
    this.dialog.addEventListener("keydown", (e) => this.onKey(e));
    dismissOutside(this.dialog, () => this.dialog.close());
    this.dialog.addEventListener("close", () => this.closed());
    for (const px of DOWNLOAD_SIZES) this.size.append(h("option", { value: String(px) }, `${px} px`));
    this.size.value = String(DEFAULT_DOWNLOAD_PX);
    this.view.append(this.picture);
    this.listenForDrag();
    this.save.addEventListener("click", () => void this.saveAvatar());
    this.reset.addEventListener("click", () => void this.resetAvatar());
    this.discordBox.addEventListener("change", () => void this.setDiscord());
    this.dialog.append(this.header(), h("div.av", null, this.stage(), this.controls));
  }

  private header(): HTMLElement {
    const close = h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => this.dialog.close() });
    close.textContent = "×";
    return h("header.acct-head", null, h("h2", null, "Avatar"), close);
  }

  private stage(): HTMLElement {
    const small = h(
      "div.av-small",
      { "aria-hidden": "true" },
      this.round,
      h("div.av-row", null, this.rowImg, this.rowName, h("span.av-row-time", null, "0:59.214")),
    );
    const download = h("button.av-link", { type: "button", onclick: () => void this.download() }, "Download PNG");
    const shuffle = h("button.av-link", { type: "button", onclick: () => this.shuffle() }, "Shuffle");
    const actions = h("div.av-actions", null, this.save, h("span.av-dl", null, download, this.size), shuffle);
    return h(
      "section.av-stage",
      { "aria-label": "Your avatar" },
      this.view,
      small,
      actions,
      this.status,
      this.discord,
      this.reset,
    );
  }

  open(): void {
    document.body.append(this.dialog);
    this.dialog.showModal();
    void this.start();
  }

  private closed(): void {
    clearTimeout(this.smallTimer);
    closeAvatarRenderer();
    this.dialog.remove();
  }

  private onKey(e: KeyboardEvent): void {
    // Keys stay in the dialog, away from the menu and game handlers underneath.
    e.stopPropagation();
    if (e.key !== "Escape" || !this.picking) return;
    e.preventDefault();
    this.closePicker();
  }

  // ---------------------------------------------------------------------------------------------
  // State

  private shown(): AvatarSpec {
    return this.preview ? cleanAvatar({ ...this.spec, ...this.preview }) : this.spec;
  }

  private setPreview(patch: Partial<AvatarSpec> | null): void {
    this.preview = patch;
    this.draw();
  }

  private setSpec(patch: Partial<AvatarSpec>, quiet = false): void {
    this.spec = cleanAvatar({ ...this.spec, ...patch });
    if (!this.signedIn) this.keepDraft();
    this.draw();
    if (!quiet) this.renderControls();
    this.say("");
  }

  private keepDraft(): void {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this.spec));
    } catch {
      // Storage refused: the draft just isn't kept.
    }
  }

  private draft(): AvatarSpec {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) return cleanAvatar(JSON.parse(saved));
    } catch {
      // No usable draft.
    }
    return cleanAvatar({ ...this.spec, ...wearing({ outfit: getOutfit(), ...getLoadout() }) });
  }

  private say(text: string, bad = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("bad", bad);
  }

  // ---------------------------------------------------------------------------------------------
  // Pictures

  private draw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      void this.drawNow();
    });
  }

  private async drawNow(): Promise<void> {
    const px = Math.min(MAX_PREVIEW_PX, Math.round(this.view.clientWidth * Math.min(2, devicePixelRatio || 1)));
    if (!px || !this.dialog.open) return;
    const spec = this.shown();
    const serial = ++this.drawSerial;
    this.view.classList.toggle("is-clear", spec.bg === "clear");
    const picture = await renderAvatar({
      output: "preview",
      size: px,
      live: true,
      spec: renderSpec(spec),
      backdrop: backdropOf(spec.bg),
    });
    if (serial !== this.drawSerial) return;
    if ("png" in picture) this.picture.src = picture.png;
    else if (!["replaced", "closed"].includes(pictureError(picture))) this.say(pictureError(picture), true);
    if (!this.preview) this.scheduleSmall();
  }

  /** The small previews (a round profile picture, a board row) from the real 256 px picture, after changes settle. */
  private scheduleSmall(): void {
    clearTimeout(this.smallTimer);
    this.smallTimer = window.setTimeout(() => void this.drawSmall(), SMALL_DELAY_MS);
  }

  private async drawSmall(): Promise<void> {
    const spec = this.spec;
    const picture = await renderAvatar({
      output: "preview",
      size: AVATAR_PX,
      spec: renderSpec(spec),
      backdrop: backdropOf(spec.bg),
    });
    if (!("png" in picture) || spec !== this.spec) return;
    this.round.src = picture.png;
    this.rowImg.src = picture.png;
  }

  private listenForDrag(): void {
    this.view.addEventListener("pointerdown", (e) => {
      this.drag = { x: e.clientX, turn: this.spec.turn };
      this.view.setPointerCapture(e.pointerId);
      this.view.classList.add("is-dragging");
    });
    this.view.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const width = Math.max(MIN_DRAG_WIDTH, this.view.clientWidth);
      const turn = this.drag.turn + ((e.clientX - this.drag.x) / width) * TURN_PER_WIDTH;
      this.setSpec({ turn: ((((turn + 180) % 360) + 360) % 360) - 180 }, true);
    });
    const end = () => {
      if (!this.drag) return;
      this.drag = null;
      this.view.classList.remove("is-dragging");
      this.renderControls();
    };
    this.view.addEventListener("pointerup", end);
    this.view.addEventListener("pointercancel", end);
  }

  // ---------------------------------------------------------------------------------------------
  // Controls

  private options(): Options {
    return options(this.unlocked);
  }

  private renderControls(): void {
    if (this.picking) return this.renderPicker(this.picking);
    this.controls.replaceChildren(this.poseSection(), this.frameSection(), this.lookSection(), this.backdropSection());
  }

  private poseSection(): HTMLElement {
    const s = this.spec;
    const setPose = (pose: AvatarSpec["pose"]) => {
      const free = !!POSES.find((p) => p.id === pose)?.free;
      this.setSpec({ pose, hand: handForPose(s, free, pose) });
    };
    return section(
      "Pose",
      POSES.find((p) => p.id === s.pose)?.name ?? null,
      list(POSES, s.pose, setPose, "av-cols"),
      slider("Moment", s.moment, [0, 1, 0.01], (moment) => this.setSpec({ moment }, true)),
      slider("Head tilt", s.tilt, [-1, 1, 0.01], (tilt) => this.setSpec({ tilt }, true)),
      slider("Ears", s.ears, [-1, 1, 0.01], (ears) => this.setSpec({ ears }, true)),
    );
  }

  private frameSection(): HTMLElement {
    const s = this.spec;
    return section(
      "Framing",
      FRAMES.find((f) => f.id === s.frame)?.name ?? null,
      list(FRAMES, s.frame, (frame) => this.setSpec({ frame }), "av-row4"),
      slider("Zoom", ZOOM_FLIP - s.zoom, [0.7, 1.6, 0.01], (z) => this.setSpec({ zoom: ZOOM_FLIP - z }, true)),
    );
  }

  private lookSection(): HTMLElement {
    const s = this.spec;
    const o = this.options();
    const knife = s.hand === "knife";
    const picks = h(
      "div.av-picks",
      null,
      this.pickRow("outfit", o),
      this.pickRow("hat", o),
      knife ? this.pickRow("knife", o) : null,
      knife ? this.pickRow("finish", o) : null,
      this.pickRow("glove", o),
    );
    const hands = [
      { id: "knife", name: "Knife" },
      { id: "gun", name: "Gun" },
      { id: "none", name: "Nothing" },
    ] as const;
    const guns = GUN_IDS.map((id) => ({ id, name: GUN_NAMES[id] }));
    return section(
      "Look",
      null,
      picks,
      ...this.hairControls(),
      h("h3", null, "Build", h("span.av-cur", null, cosmetic(s.body)?.name ?? "")),
      list(
        [
          { id: "body-a", name: "Model A" },
          { id: "body-b", name: "Model B" },
        ],
        s.body,
        (body) => this.setSpec({ body }),
        "av-row3",
      ),
      h("h3", null, "In hand", h("span.av-cur", null, this.handName(o))),
      list(hands, s.hand, (hand) => this.setSpec({ hand }), "av-row3"),
      s.hand === "gun" ? list(guns, s.gun, (gun) => this.setSpec({ gun }), "av-cols") : null,
    );
  }

  private handName(o: Options): string {
    const s = this.spec;
    if (s.hand === "gun") return GUN_NAMES[s.gun];
    if (s.hand === "none") return "Nothing";
    return o.knives.find((k) => k.id === s.knife)?.name ?? cosmetic(s.knife)?.name ?? "";
  }

  /** A wig's colour and the Ponytail's length, when the web code has them and you own the wig that's on. */
  private hairControls(): HTMLElement[] {
    const hair = hairOptions();
    const hat = this.spec.hat;
    if (!hair || !hat || !hair.isWig(hat) || !this.options().hats.some((c) => c.id === hat)) return [];
    const spec = this.spec as AvatarSpec & { hairColor?: string; hairLength?: number };
    const current = spec.hairColor ?? hair.defaultHex;
    const preset = hair.presets.find((p) => p.hex === current);
    const setHair = (hex: string | null) =>
      this.setSpec({ hairColor: !hex || hex === hair.defaultHex ? undefined : hex } as Partial<AvatarSpec>);
    const custom = h("input.av-color", { type: "color", "aria-label": "Your own hair colour" });
    custom.value = current;
    custom.addEventListener("change", () => setHair(custom.value));
    const out: HTMLElement[] = [
      h("h3", null, "Hair", h("span.av-cur", null, preset?.name ?? current.toUpperCase())),
      h(
        "div.av-hair",
        null,
        swatches(
          hair.presets.map((p) => ({ id: p.hex, name: p.name, color: p.hex })),
          preset ? current : "",
          (hex) => ((this.preview = null), setHair(hex)),
          (hex) => this.setPreview(hex ? ({ hairColor: hex } as Partial<AvatarSpec>) : null),
        ),
        custom,
      ),
    ];
    if (hair.lengthHats.includes(hat)) {
      const n = spec.hairLength ?? hair.length.default;
      const setLength = (v: number) =>
        this.setSpec({ hairLength: v === hair.length.default ? undefined : v } as Partial<AvatarSpec>, true);
      out.push(slider("Length", n, [hair.length.min, hair.length.max, 5], setLength));
    }
    return out;
  }

  private backdropSection(): HTMLElement {
    const s = this.spec;
    const items: Swatch[] = [
      { id: "clear", name: "Clear (transparent)", color: "transparent" },
      { id: defaultBg(s.outfit), name: "Colourway", color: "#18181d", color2: cosmetic(s.outfit)?.color ?? "#ffb43c" },
      ...BACKDROPS.map((b) => ({ id: b.id, name: b.name, color: b.bottom, color2: b.top })),
    ];
    const colour = h("input.av-color", { type: "color", "aria-label": "Your own colour" });
    colour.value = s.bg.startsWith("#") ? s.bg : "#1c1c22";
    colour.addEventListener("input", () => this.setSpec({ bg: colour.value }, true));
    colour.addEventListener("change", () => this.renderControls());
    const choose = (bg: string) => {
      this.preview = null;
      this.setSpec({ bg });
    };
    const hover = (bg: string | null) => this.setPreview(bg ? { bg } : null);
    return section(
      "Backdrop",
      backdropName(s.bg),
      swatches(items, s.bg, choose, hover),
      h("div.av-bgrow", null, colour),
    );
  }

  /** A row that opens a slot's picker: what you wear there, as a thumbnail and a name. */
  private pickRow(slot: Slot, o: Options): HTMLElement | null {
    const items = choicesOf(slot, o);
    if (items.length < 2) return null;
    const current = currentOf(this.spec, slot);
    return h(
      "button.av-pick",
      { type: "button", onclick: () => this.openPicker(slot) },
      thumbImg(thumbSpec(this.spec, slot, current), "av-pick-img", FOCUS[slot]),
      h("span.av-pick-label", null, SLOT_NAME[slot]),
      h("span.av-pick-name", null, items.find((i) => i.id === current)?.name ?? "None"),
      h("span.av-pick-more", { "aria-hidden": "true" }, "›"),
    );
  }

  private openPicker(slot: Slot): void {
    this.picking = slot;
    this.renderControls();
    this.controls.scrollTop = 0;
  }

  private closePicker(): void {
    this.picking = null;
    this.setPreview(null);
    this.renderControls();
  }

  /** A slot's picker: every choice you own as a thumbnail; hover previews it on the big avatar, click wears it. */
  private renderPicker(slot: Slot): void {
    const items = choicesOf(slot, this.options());
    const current = currentOf(this.spec, slot);
    const tiles = items.map((it) => {
      const patch = pickPatch(this.spec, slot, it.id);
      const wear = () => {
        this.preview = null;
        this.setSpec(patch, true);
        this.closePicker();
      };
      return h(
        "button.av-tile",
        {
          type: "button",
          role: "option",
          "aria-selected": String(it.id === current),
          onpointerenter: () => this.setPreview(patch),
          onfocus: () => this.setPreview(patch),
          onclick: wear,
        },
        thumbImg(thumbSpec(this.spec, slot, it.id), "av-tile-img", FOCUS[slot]),
        h("span.av-tile-name", null, it.name),
      );
    });
    const grid = h(
      "div.av-grid",
      { role: "listbox", "aria-label": SLOT_NAME[slot], onpointerleave: () => this.setPreview(null) },
      ...tiles,
    );
    const name = items.find((i) => i.id === current)?.name ?? null;
    const done = h("button.av-link", { type: "button", onclick: () => this.closePicker() }, "Done");
    const top = h(
      "div.av-picker-top",
      null,
      h("h2", null, SLOT_NAME[slot], name ? h("span.av-cur", null, name) : null),
      done,
    );
    this.controls.replaceChildren(h("div.av-picker", null, top, grid));
  }

  // ---------------------------------------------------------------------------------------------
  // Actions

  private async saveAvatar(): Promise<void> {
    if (!this.signedIn) return this.say("Sign in from Account to use it on the boards. Downloads still work.", true);
    this.save.disabled = true;
    this.say("Saving…");
    try {
      const picture = await renderAvatar({
        output: "webp",
        size: AVATAR_PX,
        spec: renderSpec(this.spec),
        backdrop: backdropOf(this.spec.bg),
      });
      if (!("webp" in picture)) throw new Error(pictureError(picture));
      const saved = await api.saveBunnyAvatar(this.spec, picture.webp);
      this.custom = saved.custom;
      this.spec = ownedOnly(saved.spec, this.unlocked);
      this.reset.hidden = !this.custom;
      this.showSavedPicture(saved.url);
      this.say(
        this.user?.useDiscordAvatar
          ? "Saved. Your Discord picture still shows: switch it off below to show this one."
          : "Saved. It shows on the boards and your profile now.",
      );
    } catch (e) {
      this.say(errorText(e), true);
    } finally {
      this.save.disabled = false;
    }
  }

  /** The menu's own account picture follows the new one (unless the Discord picture shows). */
  private showSavedPicture(url: string): void {
    if (!this.user || this.user.useDiscordAvatar) return;
    this.user = { ...this.user, avatarUrl: url };
    accountChanged(this.user);
  }

  private async resetAvatar(): Promise<void> {
    try {
      const r = await api.resetBunnyAvatar();
      this.custom = false;
      this.reset.hidden = true;
      this.spec = ownedOnly(r.spec, this.unlocked);
      this.showSavedPicture(r.url);
      this.draw();
      this.renderControls();
      this.say("Back to your default.");
    } catch (e) {
      this.say(errorText(e), true);
    }
  }

  private async download(): Promise<void> {
    const size = Number(this.size.value) || DEFAULT_DOWNLOAD_PX;
    this.say("Saving the picture…");
    const picture = await renderAvatar({
      output: "file",
      size,
      spec: renderSpec(this.spec),
      backdrop: backdropOf(this.spec.bg),
    });
    if ("saved" in picture) this.say(`Saved ${picture.saved}`);
    else this.say(pictureError(picture, "The picture couldn't be saved."), true);
  }

  private async setDiscord(): Promise<void> {
    const box = this.discordBox;
    box.disabled = true;
    try {
      this.user = await api.setUseDiscordAvatar(box.checked);
      accountChanged(this.user);
      this.say(box.checked ? "Your Discord picture shows instead." : "Your bunny shows now.");
    } catch (e) {
      box.checked = !box.checked;
      this.say(errorText(e), true);
    } finally {
      box.disabled = false;
    }
  }

  private shuffle(): void {
    const o = this.options();
    const outfit = pick(o.outfits).id;
    this.setSpec({
      outfit,
      hat: o.hats.length && Math.random() < 0.6 ? pick(o.hats).id : null,
      knife: pick(o.knives).id,
      finish: pick(o.finishes).id,
      glove: pick(o.gloves).id,
      hand: Math.random() < 0.85 ? "knife" : "gun",
      gun: pick(GUN_IDS),
      pose: pick(POSES).id,
      moment: Math.random(),
      tilt: (Math.random() - 0.5) * 0.8,
      ears: Math.random() * 2 - 1,
      turn: (Math.random() - 0.5) * 70,
      bg: Math.random() < 0.5 ? defaultBg(outfit) : pick(BACKDROPS).id,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Start

  private async start(): Promise<void> {
    // Until the account answers: the draft, else the loadout the game wears.
    this.spec = ownedOnly(this.draft(), this.unlocked);
    this.renderControls();
    this.draw();
    this.user = await me().catch(() => null);
    if (this.user) await this.loadAccount(this.user);
    this.save.textContent = this.signedIn ? "Use as my avatar" : "Sign in to use it";
    this.reset.hidden = !(this.signedIn && this.custom);
    this.discord.hidden = !(this.signedIn && this.user?.discordAvatarUrl && !this.user.discordAvatarBlocked);
    this.discordBox.checked = !!this.user?.useDiscordAvatar;
    if (!this.signedIn) this.say("Not signed in: free items only. Downloads still work.");
    this.renderControls();
    this.draw();
  }

  private async loadAccount(user: User): Promise<void> {
    try {
      const [cosmetics, mine] = await Promise.all([api.myCosmetics(), api.bunnyAvatar()]);
      this.unlocked = new Set(cosmetics.unlocked);
      this.signedIn = true;
      this.custom = mine.custom;
      // Your avatar: the saved one, else your default pose in the loadout you wear.
      const opened = mine.custom ? mine.spec : cleanAvatar({ ...mine.spec, ...wearing(cosmetics.choice) });
      this.spec = ownedOnly(opened, this.unlocked);
      this.rowName.textContent = user.name;
    } catch {
      this.signedIn = false;
    }
  }
}

let current: AvatarEditor | null = null;

/** Opens the editor (one at a time). */
export function openAvatarEditor(): void {
  if (current?.dialog.open) current.dialog.close();
  current = new AvatarEditor();
  current.open();
}
