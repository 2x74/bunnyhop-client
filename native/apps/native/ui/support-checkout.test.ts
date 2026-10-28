import { test, expect } from "bun:test";
import { SupportCheckout, trustedCheckoutUrl } from "./support-checkout";
import { adaptSupportSource } from "./adapt-support";
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
test("checkout permits only server Stripe checkout sessions and never substitutes an app URL", () => {
  expect(trustedCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_example#session")).toBe(
    "https://checkout.stripe.com/c/pay/cs_test_example#session",
  );
  for (const url of [
    "https://evil.example/c/pay/x",
    "https://checkout.stripe.com.evil.example/c/pay/x",
    "http://checkout.stripe.com/c/pay/x",
    "https://user@checkout.stripe.com/c/pay/x",
    "https://checkout.stripe.com:8443/c/pay/x",
    "https://checkout.stripe.com/",
    "javascript:alert(1)",
    "/?support=thanks",
  ]) {
    expect(() => trustedCheckoutUrl(url)).toThrow();
  }
});
test("constructing checkout does not request payment; only an explicit valid start opens the returned browser session", async () => {
  const requested: number[] = [],
    opened: string[] = [];
  const flow = new SupportCheckout({
    checkout: async (n) => {
      requested.push(n);
      return { url: "https://checkout.stripe.com/c/pay/test" };
    },
    openExternal: (url) => {
      opened.push(url);
      return true;
    },
    generation: () => 1,
    alive: () => true,
  });
  expect(requested).toEqual([]);
  await expect(flow.start(499, 500)).rejects.toThrow();
  expect(requested).toEqual([]);
  expect(await flow.start(500, 500)).toBe("opened");
  expect(requested).toEqual([500]);
  expect(opened).toEqual(["https://checkout.stripe.com/c/pay/test"]);
});
test("duplicate click is fenced and an account switch cannot open an old account checkout", async () => {
  let generation = 1;
  const pending = deferred<{ url: string }>(),
    opened: string[] = [];
  let requests = 0;
  const flow = new SupportCheckout({
    checkout: () => {
      requests++;
      return pending.promise;
    },
    openExternal: (u) => {
      opened.push(u);
      return true;
    },
    generation: () => generation,
    alive: () => true,
  });
  const first = flow.start(500, 500);
  expect(await flow.start(500, 500)).toBe("busy");
  generation++;
  pending.resolve({ url: "https://checkout.stripe.com/c/pay/old" });
  expect(await first).toBe("stale");
  expect(requests).toBe(1);
  expect(opened).toEqual([]);
});
test("closed screens and untrusted server URLs never open; browser rejection remains retryable", async () => {
  let alive = true;
  const pending = deferred<{ url: string }>();
  let opens = 0;
  const flow = new SupportCheckout({
    checkout: () => pending.promise,
    openExternal: () => {
      opens++;
      return true;
    },
    generation: () => 1,
    alive: () => alive,
  });
  const result = flow.start(500, 500);
  alive = false;
  pending.resolve({ url: "https://checkout.stripe.com/c/pay/x" });
  expect(await result).toBe("stale");
  expect(opens).toBe(0);
  let attempts = 0;
  const retry = new SupportCheckout({
    checkout: async () => ({
      url: ++attempts === 1 ? "https://evil.example/c/pay/x" : "https://checkout.stripe.com/pay/x",
    }),
    openExternal: () => false,
    generation: () => 1,
    alive: () => true,
  });
  await expect(retry.start(500, 500)).rejects.toThrow("untrusted");
  await expect(retry.start(500, 500)).rejects.toThrow("Couldn't open");
  expect(attempts).toBe(2);
});
test("web support adaptation preserves gift confirmation and fails on checkout navigation drift", async () => {
  const source = await Bun.file(new URL("../../web/src/ui/support.ts", import.meta.url)).text();
  const output = adaptSupportSource(source, "/native/support-checkout.ts", "/native/bridge.ts");
  expect(output).not.toContain("location.href =");
  expect(output).toContain("nativeCheckout.start(dollars()*100,min*100)");
  expect(output).toContain("if (!valid() || btn.disabled) return;");
  expect(output).toContain("Refresh support status");
  expect(() => adaptSupportSource("", "checkout", "bridge")).toThrow("anchor changed");
  const gifting = await Bun.file(new URL("../../web/src/ui/gifting.ts", import.meta.url)).text();
  expect(gifting).toContain("await api.giftPreview(wanted,write)");
  expect(gifting).toContain("api.sendGifts(reviewed, operation.id, operation.maxCost,write)");
  expect(gifting).toContain("onAccountChange(dialog,()=>{revision++;dialog.close();})");
});
