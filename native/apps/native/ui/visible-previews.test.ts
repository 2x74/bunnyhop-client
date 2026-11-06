import { expect, test } from "bun:test";
import { VisiblePreviews } from "./visible-previews";

test("only visible tiles request previews, with two in flight and cancellation on scroll or tab change", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  let intersect: (entries: IntersectionObserverEntry[]) => void = () => {};
  class Observer {
    constructor(callback: typeof intersect) {
      intersect = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { value: Observer, configurable: true });
  const queue = new VisiblePreviews();
  try {
    const started: number[] = [];
    const canceled: number[] = [];
    const completed: (() => void)[] = [];
    const elements = Array.from({ length: 240 }, () => ({}) as Element);
    for (const [id, element] of elements.entries()) {
      queue.watch(String(id), element, (done) => {
        started.push(id);
        completed[id] = done;
        return () => canceled.push(id);
      });
    }
    const visibility = (id: number, visible: boolean) =>
      ({ target: elements[id], isIntersecting: visible }) as IntersectionObserverEntry;
    expect(started).toEqual([]);
    intersect([visibility(3, true), visibility(4, true), visibility(5, true)]);
    expect(started).toEqual([3, 4]);
    completed[3]();
    expect(started).toEqual([3, 4, 5]);
    intersect([visibility(4, false), visibility(8, true)]);
    expect(canceled).toEqual([4]);
    expect(started).toEqual([3, 4, 5, 8]);
    queue.keep((key) => key === "8");
    expect(canceled).toEqual([4, 5]);
    queue.dispose();
    expect(canceled).toEqual([4, 5, 8]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  }
});
