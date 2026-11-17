// Build-time only: the website's living hilt modules for the native exporter and its oracle, with the helpers that
// place each design's moving pieces exported as they load (the designs keep them private). A helper renamed upstream
// fails here rather than putting a piece in the wrong place.
type V3 = [number, number, number];

const DESIGN_HELPERS: Record<string, string[]> = {
  clockwork: ["caseOf", "BAL", "ESC", "GEAR", "TEETH"],
  deep: ["lureOf"],
  storm: ["forkOf"],
  bloom: ["flowerOf"],
};

let registered = false;
function exposeHelpers(): void {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "live-hilt-helpers",
    setup(build) {
      build.onLoad({ filter: /hilts\/live\/designs\/(clockwork|deep|storm|bloom)\.ts$/ }, async (args) => {
        const design = args.path.match(/designs\/(\w+)\.ts$/)![1];
        const source = await Bun.file(args.path).text();
        return { contents: `${source}\nexport { ${DESIGN_HELPERS[design].join(", ")} };\n`, loader: "ts" };
      });
    },
  });
}

/** Imports the living hilts after the helpers are exposed; nothing may have imported a design before. */
export async function loadLiveHilts() {
  exposeHelpers();
  const live = "../../web/src/viewmodel/hilts/live";
  const index = await import(`${live}/index`);
  const material = await import(`${live}/material`);
  const kit = await import(`${live}/kit`);
  const design = await import(`${live}/design`);
  const state = await import(`${live}/state`);
  const { hiltAnchors } = await import(`${live}/anchors`);
  const { watcherEye } = await import(`${live}/designs/watcher`);
  const clockwork = await import(`${live}/designs/clockwork`);
  const deep = await import(`${live}/designs/deep`);
  const storm = await import(`${live}/designs/storm`);
  const bloom = await import(`${live}/designs/bloom`);
  if (typeof clockwork.caseOf !== "function" || typeof storm.forkOf !== "function")
    throw new Error("Living hilt helpers were not exposed: a design was imported before loadLiveHilts");
  /** The points each design's motion turns or moves its pieces about, per knife (knife-local). */
  function pivots(id: string, knife: unknown): Record<string, V3 | number> {
    const a = hiltAnchors(knife);
    if (id === "hilt-watcher") return { eye: watcherEye(a).c };
    if (id === "hilt-clockwork") {
      const C = clockwork.caseOf(a);
      const at = (p: [number, number]): V3 => [0, C.cy + p[0], C.zc + p[1]];
      return { balance: at(clockwork.BAL(C.R)), escape: at(clockwork.ESC(C.R)), gear: at(clockwork.GEAR(C.R)) };
    }
    if (id === "hilt-deep") return { lure: deep.lureOf(a).base };
    if (id === "hilt-storm") {
      const f = storm.forkOf(a);
      return { tipRight: f.tip(1), tipLeft: f.tip(-1), edgeRight: f.edge(1), edgeLeft: f.edge(-1) };
    }
    if (id === "hilt-bloom") return { flower: bloom.flowerOf(a).zf, gripCenter: a.grip.cy, gripHalf: a.grip.hy };
    return {};
  }

  return {
    ...index,
    ...material,
    PIECES: kit.PIECES as number,
    CHANNELS: kit.CHANNELS as number,
    PieceCtx: design.PieceCtx,
    PlaySignals: state.PlaySignals,
    hiltAnchors,
    pivots,
    TEETH: clockwork.TEETH as number,
  };
}
