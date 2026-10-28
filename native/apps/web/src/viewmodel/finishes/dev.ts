// DEV ONLY (research/COSMETICS-PLAN.md): shows any finish (through the production finish path, Viewmodel.setFinishOverride)
// and/or forces an inspect set (inspects/index.ts) on a Viewmodel from URL flags. Loaded only by viewmodel.ts under import.meta.env.DEV (dropped from builds) or by the
// dev-only lab page (vmlab.html).
//
//   ?vmfinish=sunset|ember|tigerlily|nebula|dewweb|frost|heartbeet|fourleaf|founder|none   (or an item id: fin-nebula)
//   ?vminspect=carrot|flip|karrotbit|bunnyfly|daikon|classic|default, or one trick id (hop-flip, toss-catch, ...)
//
// Live tweaking from the console: __vmcos.set({ finish: "frost" }).

import type { Viewmodel } from "../viewmodel";
import { inspectSetById, INSPECT_SETS } from "../inspects/index";
import { finishName, parseFinish, toShaderSpec, type FinishSpec } from "./finishes";

export function specFromQuery(q = new URLSearchParams(location.search)): FinishSpec {
  return { finish: parseFinish(q.get("vmfinish")) };
}

export function describe(s: FinishSpec): string {
  return s.finish === "none" ? "Garden Fresh (no finish)" : finishName(s.finish);
}

export function installDevCosmetics(vm: Viewmodel): { set(s: Partial<FinishSpec>, quiet?: boolean): void } {
  const q = new URLSearchParams(location.search);
  let spec = specFromQuery(q);
  if (q.has("vmfinish")) vm.setFinishOverride(toShaderSpec(spec));
  const insp = q.get("vminspect");
  if (insp) {
    const set = inspectSetById(insp);
    if (set) vm.inspects.setOverride(set);
    else console.warn(`vminspect: unknown inspect "${insp}" (${INSPECT_SETS.map((s) => s.id).join(", ")}, or a trick id)`);
  }
  const api = {
    set(s: Partial<FinishSpec>, quiet = false) {
      spec = { ...spec, ...s, finish: parseFinish(s.finish ?? spec.finish) };
      vm.setFinishOverride(toShaderSpec(spec));
      if (!quiet) console.info("vm finish:", describe(spec));
    },
  };
  Object.assign(window, { __vmcos: api });
  console.info("vm cosmetics prototype:", describe(spec), q.get("vminspect") ? `· inspect ${q.get("vminspect")}` : "");
  return api;
}
