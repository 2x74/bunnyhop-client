// Player-facing text where the vendored web copy is behind the website. Each fix
// applies only while its old text is there, so a web sync that brings the
// website's text turns it into a no-op.

interface CopyFix {
  file: string;
  from: string;
  to: string;
}

export const COPY_FIXES: readonly CopyFix[] = [
  {
    file: "ui/player-glow-controls.ts",
    from: '"Player glow is off in Settings."',
    to: `"Player glow is off in Settings, so you won't see it in game."`,
  },
];

/** `source` of the web file at `file` (relative to apps/web/src) with its copy fixes. */
export function adaptCopySource(file: string, source: string): string {
  let out = source;
  for (const fix of COPY_FIXES) {
    if (fix.file === file) out = out.replace(fix.from, fix.to);
  }
  return out;
}

export function hasCopyFix(file: string): boolean {
  return COPY_FIXES.some((fix) => fix.file === file);
}
