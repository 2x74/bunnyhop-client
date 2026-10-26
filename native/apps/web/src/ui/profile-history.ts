// Profile addresses share browser history with the map/router. Keep an existing deep link in its entry so a reload
// or Forward never pushes another entry (which would discard the browser's Forward history).
interface BrowserHistory {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: Pick<History, "state" | "pushState" | "replaceState" | "back">;
}

export class ProfileHistory {
  private from: string | null = null;
  private pushed = false;
  private localEntry = false;

  constructor(private browser: BrowserHistory) {}

  sync(id: string | null): void {
    const { location, history } = this.browser;
    if (id && !new URLSearchParams(location.search).has("map")) {
      const path = `/u/${encodeURIComponent(id)}`;
      if (this.from === null) {
        const query = new URLSearchParams(location.search);
        if (query.get("u") === id && location.pathname === "/") {
          query.delete("u");
          this.from = `/${query.size ? `?${query}` : ""}`;
          history.replaceState(history.state, "", path);
          return;
        }
        if (location.pathname.replace(/\/+$/, "") === path) {
          this.from = history.state?.profileFrom ?? "/";
          this.pushed = typeof history.state?.profileFrom === "string";
          return;
        }
        this.from = location.pathname + location.search + location.hash;
        this.pushed = true;
        this.localEntry = true;
        history.pushState({ ...history.state, profileFrom: this.from }, "", path);
      } else if (location.pathname !== path) {
        history.replaceState(history.state, "", path);
      }
    } else if (this.from !== null) {
      if (location.pathname.startsWith("/u/")) {
        const { profileFrom: _from, ...state } = history.state ?? {};
        history.replaceState(state, "", new URLSearchParams(location.search).has("map") ? `/${location.search}` : this.from);
      }
      this.from = null;
      this.pushed = false;
    }
  }

  // The menu's Back/Escape consumes the entry we pushed, just like browser Back. Replacing it with the origin would
  // leave two identical board/home entries. A live menu stack can handle that pop locally; after a reload, main.ts
  // restores the source from its URL instead.
  back(): "local" | "reload" | false {
    if (!this.pushed || !this.browser.location.pathname.startsWith("/u/")) return false;
    const mode = this.localEntry ? "local" : "reload";
    this.from = null;
    this.pushed = false;
    this.localEntry = false;
    this.browser.history.back();
    return mode;
  }
}
