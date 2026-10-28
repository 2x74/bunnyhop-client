export function nativeNavigate(url: string): void {
  window.dispatchEvent(new CustomEvent("bunnyhop:navigate", { detail: { url } }));
}
// Scoped build adapter for existing menu modules that assign location.href.
// Their ordinary navigation intents become native menu actions; other Location
// reads retain the real secure origin, cookie and URL behavior.
export const nativeLocation: Location = new Proxy(window.location, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  set(_target, key, value) {
    if (key !== "href") return false;
    nativeNavigate(String(value));
    return true;
  },
});
