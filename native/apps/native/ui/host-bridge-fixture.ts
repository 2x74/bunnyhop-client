// A stand-in for the native host's WebKit message handler. Messages go through the real bridge `send`, so tests see
// the exact JSON the C++ host parses.
export interface HostBridge {
  /** Every message the host received, parsed. */
  received: Record<string, unknown>[];
  restore(): void;
}

export function mockHostBridge(): HostBridge {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const received: Record<string, unknown>[] = [];
  const host = { postMessage: (raw: string) => received.push(JSON.parse(raw)) };
  const fake = { webkit: { messageHandlers: { bunnyhop: host } }, dispatchEvent: () => true };
  Object.defineProperty(globalThis, "window", { value: fake, configurable: true });
  return {
    received,
    restore() {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else delete (globalThis as { window?: unknown }).window;
    },
  };
}
