import {prefs} from "./settings";
import { glowColorPicker } from "./glow-color-picker";
import { DEFAULT_PLAYER_GLOW, GLOW_COLORS, glowColorHex, isHexGlowColor, type PlayerGlow } from "../player/glow-config";
import { api, lastKnownMe } from "../api";
import { profileWriteGuard } from "./profile-write";
import { getPlayerGlow, playerGlowRevision, setPlayerGlow } from "../player/cosmetics";
import { accountGeneration, onAccountChange } from "./account-state";
import { h } from "./dom";
import { navigate } from "./nav";
import { SUPPORTER_MIN_USD } from "../progression";
import "./support.css";

/** Shared personal glow editor: modal drafts never enter the debounced saved preferences. */
/** `support`: show non-supporters the way to get it (the Loadout; not the Support page, which is that way). */
export function playerGlowControls(o: { root: () => HTMLElement; preview: () => void; support?: boolean }) {
  let glow: PlayerGlow = { ...DEFAULT_PLAYER_GLOW };
  let savedGlow: PlayerGlow | null = null;
  let glowDraft: PlayerGlow | null = null;
  let glowDialog: HTMLDialogElement | null = null;
  let supporter = false;
  let disposed = false;
  const glowStatus = h("span.pf-status");
  let glowTimer = 0;
  let glowSeq = 0;
  const previewGlow = () => {
    o.preview();
  };
  const changeGlow = (next: PlayerGlow) => {
    glow = next;
    drawGlow();
    previewGlow();
    clearTimeout(glowTimer);
    const seq = ++glowSeq;
    const generation = accountGeneration();
    const write=profileWriteGuard(lastKnownMe()?.id??"");
    glowStatus.textContent = supporter ? "Saving…" : "Preview";
    glowStatus.className = "pf-status";
    if (!supporter) return;
    glowTimer = window.setTimeout(() => {
      if (generation !== accountGeneration() || disposed || !o.root().isConnected) return;
      const want = { ...glow };
      void api.saveSupporter({ playerGlow: want },write).then(
        (s) => {
          if (generation !== accountGeneration() || seq !== glowSeq || !o.root().isConnected) return;
          savedGlow = { ...s.playerGlow };
          glowStatus.textContent = "Saved";
          glowStatus.className = "pf-status saved";
          // Keep the equipped local bunny in sync as well as the live room patch.
          setPlayerGlow(s.playerGlow);
        },
        () => {
          if (generation !== accountGeneration() || seq !== glowSeq || !o.root().isConnected) return;
          glowStatus.textContent = "Couldn't save";
          glowStatus.className = "pf-status error";
          if (savedGlow) glow = { ...savedGlow }, drawGlow(), previewGlow();
          const revision = playerGlowRevision();
          void api.mySupport().then(s => { if (generation === accountGeneration() && seq === glowSeq && revision === playerGlowRevision() && !disposed && o.root().isConnected) seed(s?.supporter?.playerGlow ?? null); }).catch(() => {});
        },
      );
    }, 400);
  };
  const glowEnabled = h("input.switch.sm", { type: "checkbox", role: "switch", onchange: () => changeGlow({ ...glow, enabled: glowEnabled.checked }), onfocus: previewGlow });
  const glowAura = h("input.switch.sm", { type: "checkbox", role: "switch", onchange: () => changeGlow({ ...glow, aura: glowAura.checked }), onfocus: previewGlow });
  const glowColors = h("div.sp-colours", { role: "radiogroup", "aria-label": "Player glow color" },
    ...GLOW_COLORS.map(c => h("button.sp-swatch", { type: "button", role: "radio", "data-glow-color": c.id, "aria-label": c.name, title: c.name, style: `--sw:${c.hex}`, onfocus: previewGlow, onclick: () => changeGlow({ ...glow, color: c.id }) })),
  );
  const customDot = h("span.sp-glow-custom-dot", { "aria-hidden": "true" });
  const glowCustom = h("button.btn.sp-glow-custom", { type: "button", "aria-haspopup": "dialog", "aria-label": "Choose custom glow color", onfocus: previewGlow, onclick: () => {
    if (glowDialog) { glowDialog.focus(); return; }
    const generation = accountGeneration();
    glowDialog = glowColorPicker({
      current: glowColorHex(glow.color),
      preview: color => {
        if (generation !== accountGeneration() || disposed || !o.root().isConnected) return;
        // Separate from committed preferences: the existing pending debounce can never save a modal draft.
        glowDraft = { ...glow, color };
        previewGlow();
      },
      apply: color => {
        if (generation !== accountGeneration() || disposed || !o.root().isConnected) return;
        glowDraft = null;
        changeGlow({ ...glow, color });
      },
      closed: () => {
        glowDialog = null;
        glowDraft = null;
        if (!disposed && o.root().isConnected) previewGlow();
      },
    });
  } }, customDot, "Custom…");
  const glowValue = h("output");
  const glowIntensity = h("input", { type: "range", min: "0.25", max: "1", step: "0.05", "aria-label": "Player glow intensity", onfocus: previewGlow,
    oninput: () => changeGlow({ ...glow, intensity: Number(glowIntensity.value) }),
  });
  const drawGlow = () => {
    glowEnabled.checked = glow.enabled;
    glowAura.checked = glow.aura;
    customDot.style.setProperty("--sw", glowColorHex(glow.color));
    glowCustom.classList.toggle("on", isHexGlowColor(glow.color));
    glowCustom.title = isHexGlowColor(glow.color) ? `Custom color ${glow.color.toUpperCase()}` : "Choose a custom glow color";
    glowIntensity.value = String(glow.intensity);
    // The track's filled part (style.css input[type=range] reads --p, 0..1 along min..max).
    glowIntensity.style.setProperty("--p", String((glow.intensity - 0.25) / 0.75));
    glowValue.textContent = `${Math.round(glow.intensity * 100)}%`;
    for (const button of glowColors.querySelectorAll<HTMLButtonElement>("button")) {
      const selected = button.dataset.glowColor === glow.color;
      button.classList.toggle("on", selected);
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected || (isHexGlowColor(glow.color) && button.dataset.glowColor === GLOW_COLORS[0].id) ? 0 : -1;
    }
  };
  glowColors.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = GLOW_COLORS.findIndex(c => c.id === glow.color);
    const from = current < 0 ? (event.key === "ArrowLeft" || event.key === "ArrowUp" ? 0 : -1) : current;
    const index = event.key === "Home" ? 0 : event.key === "End" ? GLOW_COLORS.length - 1 :
      (from + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + GLOW_COLORS.length) % GLOW_COLORS.length;
    changeGlow({ ...glow, color: GLOW_COLORS[index].id });
    glowColors.querySelector<HTMLButtonElement>(`[data-glow-color="${glow.color}"]`)?.focus();
  });
  drawGlow();
  // Non-supporters try it here; wearing it in game is a supporter perk.
  const supportRow = h("div.sp-glow-support", { hidden: !o.support },
    h("span", null, "Supporters wear it in game."),
    h("button.btn.primary.btn-sm", { type: "button", onclick: () => navigate({ screen: "support" }) }, `Support from $${SUPPORTER_MIN_USD}`),
  );
  const glowPanel = h("div.sp-glow", null,
    h("div.sp-glow-head", null, h("h3.sp-h", null, "Player glow"), glowStatus, h("label.sp-glow-on", null, "Show", glowEnabled)),
    h("div.sp-glow-palette", null, glowColors, glowCustom),
    h("label.sp-glow-strength", null, "Intensity", glowIntensity, glowValue),
    h("label.sp-glow-aura", null, "Animated aura", glowAura),
    // Your own hands and knife: a setting of this device, not the account's glow.
    h("label.sp-glow-aura", null, "In first person", h("input.switch.sm", {
      type: "checkbox", role: "switch", checked: prefs.get().firstPersonGlow,
      onchange: (e: Event) => (prefs.update((p) => (p.firstPersonGlow = (e.currentTarget as HTMLInputElement).checked)), previewGlow()),
    })),
    h("small.dim", { hidden: prefs.get().showPlayerGlow }, "Player glow is off in Settings, so you won't see it in game."),
    supportRow,
  );
  const showSupport = () => (supportRow.hidden = supporter || !o.support);

  const seed = (next: PlayerGlow | null, preserveEdits = false) => {
    supporter = !!next;
    if (next) {
      savedGlow = { ...next };
      if (!preserveEdits) { glow = { ...next }; drawGlow(); o.preview(); }
    } else savedGlow = null;
    if (!preserveEdits) glowStatus.textContent = supporter ? "" : "Preview";
    showSupport();
  };
  const reset = () => {
    glowDialog?.close(); glowDraft = null;
    ++glowSeq; clearTimeout(glowTimer); savedGlow = null; supporter = false;
    glow = { ...DEFAULT_PLAYER_GLOW }; drawGlow(); showSupport();
  };
  const bind = () => {
    const root = o.root();
    let mounted = false;
    let attachTimeout = 0;
    const refresh = () => {
      const generation = accountGeneration();
      const revision = playerGlowRevision();
      const seq = glowSeq;
      void api.mySupport().then(s => {
        if (!disposed && root.isConnected && generation === accountGeneration()) {
          const current = revision === playerGlowRevision();
          const next = current ? s?.supporter?.playerGlow ?? null : getPlayerGlow();
          if (current && seq === glowSeq) setPlayerGlow(next);
          seed(next, seq !== glowSeq);
        }
      }).catch(() => {});
    };
    const check = () => {
      if (!mounted && root.isConnected) {
        mounted = true; clearTimeout(attachTimeout);
        onAccountChange(root, () => {
          reset(); disposed = true; glowPanel.inert = true;
          glowStatus.textContent = "Reopen to edit";
        });
        refresh();
      } else if (mounted && !root.isConnected) {
        disposed = true; reset(); observer.disconnect();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    attachTimeout = window.setTimeout(() => {
      if (!mounted) { disposed = true; reset(); observer.disconnect(); }
    }, 10_000);
    check();
  };
  return { bind, revision: () => glowSeq, panel: glowPanel, get: () => glowDraft ?? glow, seed, reset,
    dispose: () => { disposed = true; reset(); },
  };
}
