import { supportScreen, type SupportScreenOpts } from "../../web/src/ui/support";
import { h } from "../../web/src/ui/dom";
import { accountChanged } from "../../web/src/ui/account-state";
import "./support-panel.css";
/** Same web tabs, gifts, prices and account settings; native supplies the document/navigation boundary. */
export function nativeSupportScreen(options: SupportScreenOpts): HTMLElement {
  const root = h("div.native-support-screen");
  const status = h("p.native-support-return", { role: "status", "aria-live": "polite" });
  const refresh = h(
    "button.btn",
    {
      type: "button",
      onclick: () => {
        status.textContent = "Refreshing your support status below.";
        accountChanged();
      },
    },
    "Refresh support status",
  );
  root.append(supportScreen(options), h("div.native-support-refresh", null, refresh, status));
  const opened = () => {
    if (root.isConnected)
      status.textContent =
        "Complete checkout in your browser, then refresh here. Your account is updated after payment is confirmed.";
    else window.removeEventListener("bunnyhop:checkout-opened", opened);
  };
  window.addEventListener("bunnyhop:checkout-opened", opened);
  let mounted = false;
  const cleanup = new MutationObserver(() => {
    mounted ||= root.isConnected;
    if (mounted && !root.isConnected) {
      window.removeEventListener("bunnyhop:checkout-opened", opened);
      cleanup.disconnect();
    }
  });
  cleanup.observe(document.body, { childList: true, subtree: true });
  return root;
}
