// The Support page's look (ui/support.ts): the name colour and effect plus the v0.0.37 supporter looks (name font,
// avatar decoration, card border, card effect and, v0.0.40, the hover effect). DOM-free, so the rules are testable:
// - everyone can try every look on the page's cards (a preview, nothing saved);
// - a supporter's picks are their real look: seeded from GET /me/supporter and saved with POST /me/supporter, sending
//   only what changed since the last answer, one request at a time (lookSaver; the server refuses anyone else: 403
//   not_supporter).

import type { NameColorId, NameEffect } from "./creators";
import type { AvatarDecoId, CardBorderId, CardEffectId, HoverFxId, NameFontId, NameStyle } from "./supporter-looks";

export interface LookPicks {
  color: NameColorId | null;
  effect: NameEffect | null;
  font: NameFontId | null;
  /** v0.0.40: bold / italic. */
  style: NameStyle | null;
  deco: AvatarDecoId | null;
  border: CardBorderId | null;
  cardEffect: CardEffectId | null;
  hoverFx: HoverFxId | null;
}

/** The POST /me/supporter field each pick saves to. */
export const LOOK_FIELDS = {
  color: "nameColor",
  effect: "nameEffect",
  font: "nameFont",
  style: "nameStyle",
  deco: "avatarDeco",
  border: "cardBorder",
  cardEffect: "cardEffect",
  hoverFx: "hoverFx",
} as const satisfies Record<keyof LookPicks, string>;

export type LookPatch = { -readonly [K in keyof LookPicks as (typeof LOOK_FIELDS)[K]]?: LookPicks[K] };

/** What the page shows before you pick anything (and what a non-supporter starts from): a few looks on, to show them. */
export const PREVIEW_LOOK: LookPicks = { color: "aqua", effect: "sparkle", font: null, style: null, deco: "ears", border: "comet", cardEffect: null, hoverFx: null };

/** A supporter's saved picks (fields an older API leaves out are off). */
export function savedPicks(s: { nameColor: NameColorId | null; nameEffect: NameEffect | null; nameFont?: NameFontId | null; nameStyle?: NameStyle | null; avatarDeco?: AvatarDecoId | null; cardBorder?: CardBorderId | null; cardEffect?: CardEffectId | null; hoverFx?: HoverFxId | null }): LookPicks {
  return { color: s.nameColor, effect: s.nameEffect, font: s.nameFont ?? null, style: s.nameStyle ?? null, deco: s.avatarDeco ?? null, border: s.cardBorder ?? null, cardEffect: s.cardEffect ?? null, hoverFx: s.hoverFx ?? null };
}

/** The fields that differ from what's saved, as POST /me/supporter takes them; null when nothing changed. */
export function lookPatch(want: LookPicks, saved: LookPicks): LookPatch | null {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(LOOK_FIELDS) as (keyof LookPicks)[]) if (want[k] !== saved[k]) patch[LOOK_FIELDS[k]] = want[k];
  return Object.keys(patch).length ? (patch as LookPatch) : null;
}

type SavedSettings = Parameters<typeof savedPicks>[0];
export type SaveState = "idle" | "saving" | "saved" | "error";

export interface LookSaver {
  /** The supporter's saved look (GET /me/supporter): saving starts from it. */
  seed(saved: LookPicks): void;
  /** Saving is on (a saved look is known). */
  readonly seeded: boolean;
  /** The picks changed: save them a moment after the last change. */
  edit(want: LookPicks): void;
  /** Forget everything (account change, page closed): answers still in flight are ignored. */
  reset(): void;
}

/**
 * Saves a supporter's picks (Sol's review of hotfix/support-looks, R1). Each patch must be computed against what the
 * server has actually confirmed: against an older baseline, a field changed and changed back while a request was
 * still in flight would be left out of the next patch and the server would keep the in-flight value.
 * - One request at a time. Edits made meanwhile only update the wanted picks.
 * - When a request answers, its response is the new baseline. If the wanted picks still differ, the next patch is
 *   computed against it and sent, until the two agree; only then does the page say Saved.
 * - A field the server didn't take (its answer differs from what was sent) is put back on the preview from the answer,
 *   never re-sent in a loop.
 * - A failed request puts the saved look back only when nothing newer was picked since it was sent; otherwise the
 *   newer picks are sent next, against the same baseline.
 */
export function lookSaver(o: {
  save(patch: LookPatch): Promise<SavedSettings>;
  /** Put these picks on the preview (a failed save, or a field the server didn't take). */
  restore(picks: LookPicks): void;
  status(state: SaveState): void;
  delayMs?: number;
}): LookSaver {
  const delay = o.delayMs ?? 400;
  let saved: LookPicks | null = null;
  let want: LookPicks | null = null;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let generation = 0;
  /** Edits since the request in flight was sent. */
  let editedSinceSend = false;

  const send = () => {
    timer = 0;
    if (busy || !saved || !want) return;
    const patch = lookPatch(want, saved);
    if (!patch) return o.status("saved");
    const gen = generation;
    const sent = want;
    busy = true;
    editedSinceSend = false;
    o.status("saving");
    o.save(patch).then(
      (s) => {
        if (gen !== generation) return;
        busy = false;
        saved = savedPicks(s);
        // Fields the server answered differently from what was sent (an older API, or a refused value): take its answer
        // unless they were picked again since.
        const refused = (Object.keys(LOOK_FIELDS) as (keyof LookPicks)[]).filter((k) => LOOK_FIELDS[k] in patch && saved![k] !== sent[k] && want![k] === sent[k]);
        if (refused.length) {
          want = { ...want!, ...Object.fromEntries(refused.map((k) => [k, saved![k]])) };
          o.restore({ ...want });
        }
        if (timer) return; // a newer edit's debounce will send the rest
        if (lookPatch(want!, saved)) send();
        else o.status("saved");
      },
      () => {
        if (gen !== generation) return;
        busy = false;
        if (editedSinceSend) {
          // Newer picks: send them (against the last confirmed look) rather than undo them.
          if (!timer) send();
          return;
        }
        clearTimeout(timer);
        timer = 0;
        want = { ...saved! };
        o.restore({ ...want });
        o.status("error");
      },
    );
  };

  return {
    seed(s) {
      saved = { ...s };
      want = { ...s };
    },
    get seeded() {
      return !!saved;
    },
    edit(next) {
      if (!saved) return;
      want = { ...next };
      if (busy) editedSinceSend = true;
      if (!busy && !lookPatch(want, saved)) {
        clearTimeout(timer);
        timer = 0;
        return o.status("idle");
      }
      clearTimeout(timer);
      o.status("saving");
      timer = setTimeout(send, delay);
    },
    reset() {
      generation++;
      clearTimeout(timer);
      timer = 0;
      busy = false;
      saved = want = null;
    },
  };
}
