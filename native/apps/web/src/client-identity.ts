/** Self-reported UA classification for usage/support only, never authentication or trust. */
export interface ClientIdentity { kind: "desktop" | "browser" | "unknown"; version: string | null }
export function classifyClient(ua: unknown): ClientIdentity {
  if (typeof ua !== "string" || !ua.trim() || ua.length > 2048 || /[\x00-\x1f\x7f]/.test(ua)) return { kind: "unknown", version: null };
  // Exactly one whitespace-delimited product token; bounded semver including optional prerelease/build.
  const markers = ua.match(/BunnyhopClient\//g);
  if (!markers) return { kind: "browser", version: null };
  const m = /(?:^|\s)BunnyhopClient\/(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)(?=\s|$)/.exec(ua);
  return markers.length === 1 && m && m[1].length <= 64 ? { kind: "desktop", version: m[1] } : { kind: "unknown", version: null };
}

/**
 * A feedback context's client: the native C++ client says so (`client: "native"`, `nativeVersion`), since its menus are a
 * system web view whose user agent looks like a browser; otherwise the user agent decides.
 */
export function feedbackClient(context: { client?: unknown; nativeVersion?: unknown; ua?: unknown } | null | undefined): ClientIdentity | { kind: "native"; version: string | null } {
  if (context?.client === "native") {
    const v = context.nativeVersion;
    return { kind: "native", version: typeof v === "string" && /^[\w.+-]{1,32}$/.test(v) ? v : null };
  }
  return classifyClient(context?.ua);
}

/**
 * Which client a run was played on, for its diagnostics (staff see it next to the run, apps/api src/run-client.ts):
 * "desktop" when the desktop app's bridge (client-bridge.ts nativeClient()) or its user agent token is there, with the
 * app version the token carries; otherwise "browser". The native C++ client is known from the run's client build.
 * Self-reported, triage only.
 */
export function runClientInfo(bridge: unknown, ua: string): { kind: "desktop" | "browser"; version?: string } {
  const app = classifyClient(ua);
  if (!bridge && app.kind !== "desktop") return { kind: "browser" };
  return app.version ? { kind: "desktop", version: app.version } : { kind: "desktop" };
}
