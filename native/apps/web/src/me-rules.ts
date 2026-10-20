// Who's playing: when the client may conclude it's signed out (api.ts me()). DOM-free, so apps/api test/notices.test.ts
// runs it. Only the server's explicit "no session" (GET /me answering null) signs a browser out, and for a browser that
// was signed in to an account only when it says so twice; a failed request (offline, 5xx, a cut-off body) is retried and
// never reads as signed out.

/** Waits between GET /me attempts after a failed request. */
export const ME_RETRY_MS = [400, 1500] as const;
/** A known account read back as "no session": asked once more after this before a guest is started. */
export const ME_RECHECK_MS = 1200;

export interface MeIO<U extends { provider: string }> {
  /** One GET /me: the player, null for "no session"; throws without a definite answer. */
  ask: () => Promise<U | null>;
  /** The error was "no answer" (worth retrying), not a refusal. */
  transient: (e: unknown) => boolean;
  /** Starts a guest identity (POST /auth/guest; it replaces the session cookie). */
  guest: () => Promise<U>;
  /** The player this browser last had a confirmed answer for. */
  known: () => U | null;
  /** Drops that memory (signed out for sure). */
  forget: () => void;
  wait: (ms: number) => Promise<void>;
}

/**
 * The me() decision: transient failures are retried; an explicit "no session" for a browser that was signed in to an
 * account is asked again before a guest is created (that replaces the session cookie, so one stray answer mustn't do
 * it). Throws when no answer came (the caller keeps showing the last player).
 */
export async function resolveMe<U extends { provider: string }>(io: MeIO<U>): Promise<U> {
  const ask = async () => {
    for (let i = 0; ; i++) {
      try {
        return await io.ask();
      } catch (e) {
        if (!io.transient(e) || i >= ME_RETRY_MS.length) throw e;
        await io.wait(ME_RETRY_MS[i]);
      }
    }
  };
  let u = await ask();
  if (u) return u;
  const known = io.known();
  if (known && known.provider !== "guest") {
    await io.wait(ME_RECHECK_MS);
    u = await ask();
    if (u) return u;
  }
  // Signed out for sure: whatever this browser remembered is gone, and a guest identity starts (guest-first).
  io.forget();
  return io.guest();
}
