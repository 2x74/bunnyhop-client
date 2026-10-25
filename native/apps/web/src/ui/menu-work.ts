// Menu preparation stops as soon as a map starts loading, including viewers which never take pointer lock.
let mapStarted = false;
const mapStart = new Set<() => void>();

export function menuIdleAllowed(): boolean {
  return !mapStarted && !document.pointerLockElement;
}

export function onMenuMapStart(fn: () => void): void {
  mapStart.add(fn);
}

export function stopMenuWork(): void {
  mapStarted = true;
  for (const fn of mapStart) fn();
}
