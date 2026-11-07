// The menu needs target parsing and messages; replay simulation stays in the native host.
export type CopyStartTarget = { kind: "wr" } | { kind: "rank"; rank: number } | { kind: "name"; name: string };
export function parseCopyStart(arg: string): CopyStartTarget {
  const text = arg.trim();
  if (!text) return { kind: "wr" };
  const rank = /^#?(\d{1,6})$/.exec(text);
  if (rank && Number(rank[1]) >= 1)
    return Number(rank[1]) === 1 ? { kind: "wr" } : { kind: "rank", rank: Number(rank[1]) };
  return { kind: "name", name: text };
}
export function copiedMessage(who: string, track: number, restarted: boolean): string {
  const where = track > 0 ? ` for Bonus ${track}` : "";
  return `Copied ${who}'s start point${where}${restarted ? "" : ". Restart to use it"}`;
}
