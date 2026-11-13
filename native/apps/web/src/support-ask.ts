// The Support page's ask (ui/support.ts): what it shows once the player's support status is read. "Supporting opens
// soon" is the server's own answer that payments are off, never a guess: a read that failed, or a player with no
// session to read for, says the status couldn't load and offers to try again.
import type { MySupport } from "./api";

export type Ask = "thanks" | "pay" | "soon" | "failed";

/** The ask for a status (null: it could not be read). */
export const askOf = (s: MySupport | null): Ask => (!s ? "failed" : s.supporter ? "thanks" : s.payments ? "pay" : "soon");

/** Who is playing and their support status. `status` is null when either read failed or there is no session. */
export async function supportStatus<U, R>(me: () => Promise<U | null>, read: (user: U) => Promise<R>): Promise<{ user: U | null; status: R | null }> {
  let user: U | null = null;
  try {
    user = await me();
    return { user, status: user ? await read(user) : null };
  } catch {
    return { user, status: null };
  }
}
