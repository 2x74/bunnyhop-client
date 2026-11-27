// The privacy form's checks (ui/privacy.ts), shared with the API so both refuse the same requests (apps/api
// src/feedback.ts submitPrivacy). v0.0.44 (TyZi's tickets): a "correct" or "other" request with no note says nothing,
// and an email box holding a sentence is a note typed in the wrong place.
/** The four requests (api.ts PrivacyRequestKind is this). */
export type PrivacyRequestKind = "export" | "delete" | "correct" | "other";

/** Kinds whose request is the note itself: sent empty, the developer can't act on them. */
export const NOTE_REQUIRED: readonly PrivacyRequestKind[] = ["correct", "other"];
/** Something@somewhere.tld, no spaces. Loose on purpose: a typo'd address still reaches a person who can ask again. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const looksLikeEmail = (s: string): boolean => EMAIL.test(s);

/** What's wrong with a privacy request (trimmed note and contact), or null. `field` says where to put the cursor. */
export function privacyRequestProblem(kind: PrivacyRequestKind, note: string, contact: string): { code: "note_required" | "bad_contact"; field: "note" | "contact"; message: string } | null {
  if (NOTE_REQUIRED.includes(kind) && !note.trim()) return { code: "note_required", field: "note", message: "Write what you need in the note box" };
  if (contact.trim() && !looksLikeEmail(contact.trim())) return { code: "bad_contact", field: "contact", message: "That email doesn't look right. Leave it empty to get the reply in your inbox" };
  return null;
}
