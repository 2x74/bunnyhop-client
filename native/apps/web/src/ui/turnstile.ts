// Cloudflare Turnstile, for a password login that needs it (apps/api src/password.ts): only then is the script loaded, from
// the exact URL Cloudflare requires. Clients where it can't run get told so instead: the Wavedash build's frame is
// cross-origin isolated, which an iframe from another site can't join, and the native menu's CSP refuses the script (its
// load error lands here). The caller then points the player to email or Discord.

import { WAVEDASH } from "../platform/env";
import { h } from "./dom";

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const LOAD_TIMEOUT_MS = 10_000;
/** apps/api src/password.ts TURNSTILE_ACTION: siteverify answers with it, and the server compares. */
const ACTION = "password-login";

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(id: string): void;
  remove(id: string): void;
}

let loading: Promise<TurnstileApi | null> | null = null;

function load(): Promise<TurnstileApi | null> {
  return (loading ??= new Promise<TurnstileApi | null>((resolve) => {
    const script = h("script", { src: SCRIPT, async: true }) as HTMLScriptElement;
    const done = (api: TurnstileApi | null) => {
      clearTimeout(timer);
      // Retried on the next need: a blip shouldn't cost the rest of the page's life.
      if (!api) loading = null;
      resolve(api);
    };
    const timer = setTimeout(() => done(null), LOAD_TIMEOUT_MS);
    script.addEventListener("load", () => done((window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null));
    script.addEventListener("error", () => done(null));
    document.head.append(script);
  }));
}

export interface TurnstileWidget {
  /** A fresh token after one was used or refused. */
  reset(): void;
  remove(): void;
}

/**
 * Shows the check in `box`. onToken gets each passed check; onUnavailable means it can't run here. Resolves to the widget, or
 * null if it couldn't start.
 */
export async function mountTurnstile(box: HTMLElement, siteKey: string, onToken: (token: string) => void, onUnavailable: () => void): Promise<TurnstileWidget | null> {
  const api = WAVEDASH ? null : await load();
  if (!api) {
    onUnavailable();
    return null;
  }
  let id: string | undefined;
  try {
    id = api.render(box, {
      sitekey: siteKey,
      action: ACTION,
      theme: "dark",
      size: "flexible",
      callback: onToken,
      "error-callback": () => {
        onUnavailable();
        return true;
      },
    });
  } catch {
    onUnavailable();
    return null;
  }
  if (id === undefined) {
    onUnavailable();
    return null;
  }
  const widget = id;
  return { reset: () => api.reset(widget), remove: () => api.remove(widget) };
}
