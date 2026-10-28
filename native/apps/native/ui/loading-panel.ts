import { h } from "../../web/src/ui/dom";
import { send, state } from "./bridge";
import "./loading-panel.css";
let host: HTMLElement | null = null,
  wasLoading = false,
  failed = false,
  lastFailure = "";
const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
/** Independent host preserves the animated spinner while progress changes. */
export function paintLoading(): void {
  const loading = !!state.loading,
    p = state.loadProgress;
  const failure = !loading && state.error && p?.stage === "error" ? `${p.map}:${p.message}` : "";
  if (failure && failure !== lastFailure) failed = true;
  lastFailure = failure;
  if (wasLoading && !loading) failed = !!state.error;
  wasLoading = loading;
  if (!loading && !state.error) failed = false;
  if (!loading && !failed) {
    host?.remove();
    host = null;
    return;
  }
  if (!host) {
    host = h("section.native-loading", { "aria-label": "Map loading" }, h("div.native-loading-card"));
    document.body.append(host);
  }
  const title = loading ? (p?.map ? `Loading ${p.map}` : "Loading map") : "Map could not load";
  const message = loading
    ? p?.message || (typeof state.loading === "string" ? state.loading : "Preparing native renderer…")
    : (state.error ?? "Download interrupted");
  const ratio = p && p.total > 0 ? Math.min(1, p.received / p.total) : null;
  const bar = h("progress", { max: 1, "aria-label": "Current file download" });
  if (ratio !== null) bar.value = ratio;
  const detail =
    loading && p
      ? `${p.total > 0 ? `${bytes(p.received)} / ${bytes(p.total)}` : ""}${p.filesTotal ? ` · ${p.filesDone} / ${p.filesTotal} content files` : ""}`
      : "";
  const actions = loading
    ? h("button", { type: "button", onclick: () => send({ type: "mapLoad", action: "cancel" }) }, "Cancel")
    : h(
        "div.native-loading-actions",
        null,
        h("button", { type: "button", onclick: () => send({ type: "mapLoad", action: "retry" }) }, "Retry"),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              failed = false;
              paintLoading();
            },
          },
          "Back",
        ),
      );
  host.firstElementChild!.replaceChildren(
    host.querySelector(".native-loading-spinner") ?? h("span.native-loading-spinner", { "aria-hidden": "true" }),
    h("h2", null, title),
    h("p", { role: "status", "aria-live": "polite" }, message),
    ...(loading ? [bar] : []),
    h("small", null, detail),
    ...(p?.offline ? [h("small", null, "Offline · using the last downloaded version")] : []),
    actions,
  );
  host.classList.toggle("failed", !loading);
}
