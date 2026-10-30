// The "zones unconfirmed" map label (maps/index.json `zoneWarning`, tools/zones/zone-warning.ts): a map whose zones are
// incomplete or couldn't be confirmed against a real run. Throwtop's ask after 20 minutes on a map with no end zone:
// "should really be some kind of warning, automatically, if zones aren't done". Only a label: the map stays ranked and
// plays the same.

const isBonus = (label: string): boolean => /^bonus/i.test(label);

/** The label's hover line (the map panel). */
export const zoneWarningNote = (label: string): string =>
  isBonus(label)
    ? "A bonus on this map is missing a start or end zone, so that bonus can't be timed. The main track is fine."
    : "We couldn't confirm this map's zones against a real run, so the timer may not stop where the map seems to end.";

/** The line on loading the map. */
export const zoneWarningToast = (label: string): string =>
  isBonus(label) ? `${label}: a bonus run here can't finish.` : `${label}: your run may not finish where the map seems to end.`;
