// "Keep this run" (web ui/keep-run.ts) lets go of its field when pointer lock comes back, and the menu's web view never
// has pointer lock. Back in the game the field must not keep the focus: it would take the next pause's keys as typing.
export function releaseKeepRunField(doc: Document = document): void {
  const active = doc.activeElement as HTMLElement | null;
  if (active?.closest?.(".keep-run")) active.blur();
}
