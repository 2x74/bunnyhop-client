// Exit game: the main menu's last entry and the pause menu's last row, as in the website's desktop app
// (apps/web/src/exit-game.ts). A fullscreen game has no window frame to close, and the quiet Quit link under the footer
// was easy to miss. The host quits through its normal shutdown, the same path as closing the window.
//
// The pause menu asks once while a timed run is going, since the run would be lost; the main menu never asks. A run
// that has finished and is being checked or uploaded gets a moment first: the host keeps its replay either way, and a
// kept run is uploaded on the next start, but finishing now puts it on the board today.

/** The longest the exit waits for a finished run's upload. */
export const EXIT_UPLOAD_WAIT_MS = 1500;
const UPLOAD_POLL_MS = 50;

export interface ExitGameDeps {
  /** A timed run is going (the host's timer status is running). */
  runInProgress: () => boolean;
  /** A finished run is being checked or uploaded. */
  uploading: () => boolean;
  /** The one question; true to exit. */
  confirm: () => Promise<boolean>;
  /** Tells the host to quit. */
  quit: () => void;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Quits the game, asking first when `ask` and a run is going. False when the player said no. */
export async function exitGame(deps: ExitGameDeps, ask: boolean): Promise<boolean> {
  if (ask && deps.runInProgress() && !(await deps.confirm())) return false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.waitMs ?? EXIT_UPLOAD_WAIT_MS;
  for (let waited = 0; deps.uploading() && waited < waitMs; waited += UPLOAD_POLL_MS) await sleep(UPLOAD_POLL_MS);
  deps.quit();
  return true;
}

/** Run service statuses that mean a finished run is still on its way to the server (run-service.ts). */
export function uploadingStatus(status: string | null): boolean {
  return status === "checking" || status === "uploading";
}

/** The console's `quit` and `exit` close the game, as in Source (`disconnect` still goes back to the menu). */
export function isQuitCommand(command: string): boolean {
  const words = command.trim().toLowerCase().split(/\s+/);
  return words.length === 1 && (words[0] === "quit" || words[0] === "exit");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The power symbol, drawn like the web's icons (ui/icons.ts: 20-unit grid, 1.7 stroke, square caps). The website adds
 * it there as "power"; this copy goes once the vendored web has it.
 */
export function powerIcon(size: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attributes: Record<string, string> = {
    class: "icon",
    viewBox: "0 0 20 20",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "square",
    "stroke-linejoin": "miter",
    focusable: "false",
    "aria-hidden": "true",
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  for (const d of ["M14.2 5.5A6.5 6.5 0 1 1 5.8 5.5", "M10 2.5V9.5"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
