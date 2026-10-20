// Tiny synchronous event bus for things that make sounds but live outside the audio module.
//
// The first-person viewmodel (the carrot) emits "swing" / "stab" / "draw"; audio/index.ts plays them. Emitters don't
// import the audio engine (and work fine when audio never starts). Listeners run synchronously in emit order; no
// allocation per emit.
//
//   import { viewmodelEvents } from "../audio/events";
//   viewmodelEvents.emit("swing");             // optional detail: viewmodelEvents.emit("stab", { hit: true })

export type ViewmodelEvent = "swing" | "stab" | "draw";

export interface ViewmodelDetail {
  /** The stab / swing connected with something (a crunchier variant). */
  hit?: boolean;
  /** 0..1 strength (gain scale). */
  strength?: number;
}

type Listener<E extends string, D> = (event: E, detail: D | undefined) => void;

export class EventBus<E extends string, D = undefined> {
  private listeners: Listener<E, D>[] = [];

  /** Subscribes to every event. Returns an unsubscribe function. */
  on(fn: Listener<E, D>): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(event: E, detail?: D): void {
    const l = this.listeners;
    for (let i = 0; i < l.length; i++) {
      try {
        l[i](event, detail);
      } catch (e) {
        console.warn("event listener:", e);
      }
    }
  }
}

/** Viewmodel (first-person carrot) events: swing, stab, draw. */
export const viewmodelEvents = new EventBus<ViewmodelEvent, ViewmodelDetail>();
