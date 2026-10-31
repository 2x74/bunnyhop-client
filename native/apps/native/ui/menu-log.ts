// The menu's side of the game's log file (native_log.hpp): what went wrong in this document, and why a map pick didn't
// reach the host. The host writes these with the rest of the session, after taking out anything private.
import { send } from "./bridge";

const MAX_LOG_LINE = 1000;
const MAX_ERROR_LINES = 200;
let errorLines = 0;
let lastError = "";

export function logToHost(text: string): void {
  try {
    send({ type: "menuLog", text: text.slice(0, MAX_LOG_LINE) });
  } catch {
    /* the log must never add a failure of its own */
  }
}

function logError(text: string): void {
  if (text === lastError || errorLines >= MAX_ERROR_LINES) return;
  lastError = text;
  errorLines++;
  logToHost(text);
}

const describe = (value: unknown): string =>
  value instanceof Error ? (value.stack ?? `${value.name}: ${value.message}`) : String(value);

/** Errors nothing else caught: the document keeps running, so these would otherwise leave no trace at all. */
export function installMenuErrorLog(): void {
  window.addEventListener("error", (event) => {
    logError(`error: ${event.error ? describe(event.error) : event.message}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    logError(`unhandled rejection: ${describe(event.reason)}`);
  });
}
