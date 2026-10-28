#!/usr/bin/env bun
/** Optimized production web renderer benchmark. Run --prepare first; timing is explicitly --run.
 * bun native/apps/native/tools/web-render-benchmark.ts --prepare --web-root /path/to/web-repo
 * bun native/apps/native/tools/web-render-benchmark.ts --run --spec scene.json [--headed]
 * Scene: {map,path,contentRoot?,width,height,eye:[x,y,z],yaw,pitch,frames:600,warmup:120,sourceLook:false,floorWeapons:true,sync:"readback"|"finish"|"batch",out}
 * Times are render submission and synchronized render+GPU/readback wall time, NOT presented FPS.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { createHash } from "node:crypto";
const arg = (key: string, fallback: string) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
};
const webRoot = resolve(arg("--web-root", "/Users/hunter/src/bunnyhop-gfx-native"));
const outputRoot = resolve(import.meta.dirname, "../../../target/perf-web");
const source = resolve(webRoot, "apps/web");
const hook =
  "if (import.meta.env.DEV) Object.assign(window, { bunnyhop: { input, core, camera, scene, renderer, graphicsPipeline, world: w } });";
const gunHook =
  "if (import.meta.env.DEV) Object.assign(window, { __weapons: arms, __hitEffects: hitEffects, __guns: gunView });";
if (process.argv.includes("--prepare")) {
  const { build } = await import(Bun.resolveSync("vite", source));
  let exposed = false;
  await build({
    root: source,
    configFile: false,
    mode: "production",
    publicDir: false,
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(""),
      "import.meta.env.VITE_CONTENT_URL": JSON.stringify(""),
    },
    plugins: [
      {
        name: "benchmark-existing-renderer-and-weapon-hooks",
        enforce: "pre",
        transform(code: string, id: string) {
          if (id !== resolve(source, "src/main.ts")) return;
          if (!code.includes(hook) || !code.includes(gunHook))
            throw Error("Existing main.ts renderer/weapon hooks changed; refusing broad DEV replacement");
          exposed = true;
          return (
            `import { floorWeapons as benchmarkFloorWeapons } from "./core";\n` +
            code
              .replace(hook, hook.replace("if (import.meta.env.DEV) ", ""))
              .replace(
                gunHook,
                gunHook
                  .replace("if (import.meta.env.DEV) ", "")
                  .replace("__guns: gunView", "__guns: gunView, __floorWeapons: benchmarkFloorWeapons"),
              )
          );
        },
      },
    ],
    build: {
      target: "es2022",
      outDir: outputRoot,
      emptyOutDir: true,
      minify: true,
      rollupOptions: { input: resolve(source, "index.html") },
    },
  });
  if (!exposed) throw Error("Renderer hook was not exposed");
  writeFileSync(
    resolve(outputRoot, "benchmark-build.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        webRoot,
        mode: "production",
        instrumentation: "Existing main.ts renderer/weapon hooks enabled; core floorWeapons helper exposed",
        mainSHA256: createHash("sha256")
          .update(readFileSync(resolve(source, "src/main.ts")))
          .digest("hex"),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ prepared: true, outputRoot }));
}
if (!process.argv.includes("--run")) process.exit(0);
if (!existsSync(resolve(outputRoot, "benchmark-build.json"))) throw Error("Run --prepare before --run");
interface Spec {
  map: string;
  path: string;
  contentRoot?: string;
  width: number;
  height: number;
  eye: [number, number, number];
  yaw: number;
  pitch: number;
  frames?: number;
  warmup?: number;
  sourceLook?: boolean;
  floorWeapons?: boolean;
  sync?: "readback" | "finish" | "batch";
  out: string;
}
const spec = JSON.parse(readFileSync(resolve(arg("--spec", "")), "utf8")) as Spec;
if (
  !/^[a-zA-Z0-9_-]+$/.test(spec.map) ||
  ![spec.width, spec.height, ...spec.eye, spec.yaw, spec.pitch].every(Number.isFinite) ||
  spec.eye.length !== 3 ||
  !spec.out
)
  throw Error("Invalid scene spec");
const probe = process.argv.includes("--probe");
const frames = spec.frames ?? 600,
  warmup = spec.warmup ?? 120;
spec.sourceLook ??= false;
spec.floorWeapons ??= true;
spec.sync ??= "readback";
if (
  typeof spec.sourceLook !== "boolean" ||
  typeof spec.floorWeapons !== "boolean" ||
  !["readback", "finish", "batch"].includes(spec.sync)
)
  throw Error("Invalid render options");
if (spec.sourceLook && !probe)
  throw Error(
    "Source-look timing is disabled: its asynchronous exposure readback requires event-loop yields between frames. Use classic (sourceLook:false) until exposure scheduling is matched.",
  );
if (
  !Number.isInteger(frames) ||
  frames < 1 ||
  frames > 10000 ||
  !Number.isInteger(warmup) ||
  warmup < 0 ||
  warmup > 10000
)
  throw Error("Invalid frame counts");
const bytes = readFileSync(resolve(spec.path)),
  sha256 = createHash("sha256").update(bytes).digest("hex"),
  contentRoot = resolve(spec.contentRoot ?? resolve(webRoot, "content-cache"));
const nativeManifestPath = [resolve(contentRoot, "manifest.json"), resolve(contentRoot, "../manifest.json")].find(
  existsSync,
);
const nativeManifest = nativeManifestPath ? JSON.parse(readFileSync(nativeManifestPath, "utf8")) : null;
if (nativeManifest && nativeManifest.mapSha256 !== sha256)
  throw Error("Content manifest BSP hash does not match supplied map");
const nativeHashes = new Map<string, string>(),
  supplementalLocalContent: string[] = [];
function indexManifestFiles(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [path, file] of Object.entries(value)) {
    if (
      file &&
      typeof file === "object" &&
      "sha256" in file &&
      typeof file.sha256 === "string" &&
      !path.includes("..") &&
      !path.startsWith("/")
    ) {
      let local = [resolve(contentRoot, "content", path), resolve(contentRoot, path)].find(existsSync);
      if (!local) {
        const cached = resolve(webRoot, "content-cache/content", file.sha256);
        if (existsSync(cached) && createHash("sha256").update(readFileSync(cached)).digest("hex") === file.sha256) {
          local = cached;
          supplementalLocalContent.push(path);
        }
      }
      if (local) nativeHashes.set(file.sha256, local);
    } else indexManifestFiles(file);
  }
}
indexManifestFiles(nativeManifest);
const missingFiles = new Set<string>(),
  blocked = new Set<string>(),
  errors: string[] = [];
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
const roots = [outputRoot, resolve(webRoot, "maps"), resolve(source, "public-site")];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "GET") return new Response("Read-only benchmark", { status: 405 });
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.includes("..")) return new Response("Invalid path", { status: 400 });
    if (path === "/index.json")
      return Response.json({
        maps: [{ name: spec.map, title: spec.map, sha256, size: bytes.length, tier: 1, tracks: 1 }],
      });
    if (path === `/${spec.map}.bsp` || path === `/api/bsp/${sha256}.bsp`)
      return new Response(bytes, {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) },
      });
    if (path === `/content-manifests/${sha256}.json` && nativeManifest) return Response.json(nativeManifest);
    if (/^\/content\/[a-f0-9]{64}$/.test(path) && nativeHashes.has(path.split("/")[2]))
      return new Response(Bun.file(nativeHashes.get(path.split("/")[2])!));
    if (/^\/(content\/[a-f0-9]{64}|content-manifests\/[a-f0-9]{64}\.json)$/.test(path)) {
      const file = resolve(contentRoot, "." + path);
      if (existsSync(file)) return new Response(Bun.file(file));
      missingFiles.add(path);
      return new Response("Missing local content", { status: 404 });
    }
    if (path.startsWith("/api/")) return Response.json({ error: "offline_benchmark" }, { status: 503 });
    for (const root of roots) {
      const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
      if (existsSync(file) && statSync(file).isFile())
        return new Response(Bun.file(file), {
          headers: { "Content-Type": types[extname(file)] ?? Bun.file(file).type },
        });
    }
    missingFiles.add(path);
    return new Response("Missing local asset", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const settings = {
  fov: 90,
  showZones: false,
  hud: { hidden: true },
  viewmodel: { show: false },
  ghost: { show: false },
  graphics: {
    preset: spec.sourceLook ? "source" : "classic",
    potato: false,
    waterReflections: false,
    fullscreen: false,
    menuBackground: "off",
    resolutionScale: 1,
    antialias: false,
    anisotropy: 8,
    brightness: 1,
    gamma: 1,
    vibrance: 1,
    fullbright: false,
    flashlight: false,
    fpsLimit: 0,
    uncapped: false,
    mapProfiles: false,
    materialResponse: false,
    localLights: false,
    dynamicShadows: false,
    dynamicGI: false,
    tracedGI: false,
    clouds: false,
    skyMode: "map",
    lightingSource: "map",
  },
};
const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  args: [
    ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-gpu-vsync",
  ],
});
try {
  const context = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: 1,
  });
  await context.routeWebSocket(/.*/, () => {});
  await context.route("**/*", (route) => {
    const request = route.request();
    if (request.method() !== "GET" || new URL(request.url()).origin !== origin) {
      blocked.add(`${request.method()} ${request.url()}`);
      return route.abort();
    }
    return route.continue();
  });
  await context.addInitScript((p) => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:gfx-detect", "measured");
    localStorage.setItem("bunnyhop:tutorial", "0");
    localStorage.setItem("bunnyhop:settings", JSON.stringify(p));
  }, settings);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/?map=${spec.map}`);
  await page.waitForFunction(
    () =>
      document.body.classList.contains("in-game") &&
      !!(window as any).bunnyhop?.world &&
      !!(window as any).__guns?.floor,
    null,
    { timeout: 240000 },
  );
  // Let all existing RAF work drain. This changes scheduling only after real map/world initialization.
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  await page.waitForTimeout(100);
  await page.waitForLoadState("networkidle");
  const result = await page.evaluate(
    async ({ spec, frames, warmup, settings, probe }) => {
      const B = (window as any).bunnyhop,
        G = (window as any).__guns,
        floorState = (window as any).__floorWeapons,
        gl = B.renderer.getContext() as WebGL2RenderingContext;
      const debug = gl.getExtension("WEBGL_debug_renderer_info"),
        pixel = new Uint8Array(4);
      for (const child of B.scene.children)
        child.visible = child === B.world.root || (spec.floorWeapons && child === G.floor.root);
      G.floor.root.visible = spec.floorWeapons;
      B.world.root.visible = true;
      B.world.setFlashlight(false);
      B.world.setFullbright(false);
      B.world.setPotato(false);
      B.graphicsPipeline.setOptions(settings.graphics);
      B.renderer.setPixelRatio(1);
      B.renderer.setSize(spec.width, spec.height, false);
      B.graphicsPipeline.setSize(spec.width, spec.height);
      B.camera.position.set(spec.eye[0], spec.eye[2], -spec.eye[1]);
      B.camera.rotation.order = "YXZ";
      B.camera.rotation.set((-spec.pitch * Math.PI) / 180, ((spec.yaw - 90) * Math.PI) / 180, 0, "YXZ");
      B.camera.fov = 73.73979529168804;
      B.camera.aspect = spec.width / spec.height;
      B.camera.updateProjectionMatrix();
      B.camera.updateMatrixWorld(true);
      for (const child of Array.from(document.body.children) as HTMLElement[])
        if (child !== B.renderer.domElement) child.style.display = "none";
      B.renderer.domElement.style.cssText = `position:fixed;inset:0;width:${spec.width}px;height:${spec.height}px;display:block`;
      const updateFloor = () => {
        const state = floorState(B.core);
        if (spec.floorWeapons) G.floor.update(state);
        return state.length / 9;
      };
      const floorCount = updateFloor();
      const initialFloorState = floorState(B.core);
      let floorPresentCount = 0;
      for (let i = 2; i < initialFloorState.length; i += 9) if (initialFloorState[i] & 1) floorPresentCount++;
      // FloorGuns currently constructs its cached procedural models synchronously in update().
      // Compile all visible materials before warmup; await Three's asynchronous shader readiness where available.
      B.world.update(B.core.brushOrigins(), 0, B.core.effectStates());
      await B.graphicsPipeline.prepareForExport();
      await B.renderer.compileAsync(B.scene, B.camera);
      const render = (i: number) => {
        const transforms = B.core.brushOrigins(),
          effects = B.core.effectStates();
        updateFloor();
        B.world.update(transforms, i / 60, effects);
        B.graphicsPipeline.render(B.scene, B.camera, i / 60);
      };
      const sync = () => {
        if (spec.sync !== "batch") gl.finish();
        if (spec.sync === "readback") gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      };
      if (probe) {
        render(0);
        sync();
      } else
        for (let i = 0; i < warmup; i++) {
          render(i);
          sync();
        }
      gl.finish();
      const samples: { frame: number; submissionMs: number; finishMs: number; readbackMs: number; wallMs: number }[] =
        [];
      const batchStart = performance.now();
      for (let i = 0; i < (probe ? 0 : frames); i++) {
        const start = performance.now();
        render(warmup + i);
        const submitted = performance.now();
        if (spec.sync !== "batch") gl.finish();
        const finished = performance.now();
        if (spec.sync === "readback") gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const end = performance.now();
        samples.push({
          frame: i,
          submissionMs: submitted - start,
          finishMs: finished - submitted,
          readbackMs: end - finished,
          wallMs: end - start,
        });
      }
      gl.finish();
      const batchMs = performance.now() - batchStart;
      const materials = B.core.materials(),
        missing = materials
          .map((m: any, i: number) => ({ m, i }))
          .filter(({ m }: any) => m.kind === 1)
          .map(({ i }: any) => B.core.mesh().materials[i]?.name ?? i);
      return {
        samples,
        sync: spec.sync,
        batchMs,
        batchFPS: (1000 * frames) / batchMs,
        visualTime: "warmup starts at 0; measured starts at warmup/60",
        floorWeapons: {
          enabled: spec.floorWeapons,
          count: floorCount,
          presentCount: floorPresentCount,
          meshes: G.floor.root.children.length,
          visibleMeshes: G.floor.root.children.filter((c: any) => c.visible).length,
          rootVisible: G.floor.root.visible,
          rootInScene: B.scene.children.includes(G.floor.root),
        },
        authoredHDR: B.world.root.userData.lightmapHdr === true,
        effectiveHDR: spec.sourceLook && B.world.root.userData.lightmapHdr === true && B.graphicsPipeline.supported,
        effectivePreset: B.graphicsPipeline.getOptions().preset,
        sourceExposure: B.graphicsPipeline.getSourceExposure(),
        gpu: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
        webgl: gl.getParameter(gl.VERSION),
        viewport: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, dpr: devicePixelRatio },
        camera: {
          eye: spec.eye,
          threePosition: B.camera.position.toArray(),
          yaw: spec.yaw,
          pitch: spec.pitch,
          verticalFov: B.camera.fov,
        },
        settings: B.graphicsPipeline.getOptions(),
        missingMaterialCandidates: missing,
        materialCount: materials.length,
        drawCalls: B.renderer.info.render.calls,
        triangles: B.renderer.info.render.triangles,
        glError: gl.getError(),
        userAgent: navigator.userAgent,
      };
    },
    { spec, frames, warmup, settings, probe },
  );
  const out = resolve(spec.out);
  mkdirSync(dirname(out), { recursive: true });
  const screenshot = out.replace(/\.json$/i, "") + ".png";
  await page.screenshot({ path: screenshot });
  if (probe) {
    console.log(
      JSON.stringify(
        {
          probe: true,
          screenshot,
          map: spec.map,
          gpu: result.gpu,
          floorWeapons: result.floorWeapons,
          authoredHDR: result.authoredHDR,
          effectiveHDR: result.effectiveHDR,
          effectivePreset: result.effectivePreset,
          drawCalls: result.drawCalls,
          triangles: result.triangles,
          glError: result.glError,
          missingFiles: [...missingFiles],
          errors,
        },
        null,
        2,
      ),
    );
    if (errors.length || result.glError) process.exitCode = 1;
  } else {
    const summarize = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        median:
          sorted.length % 2
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        max: sorted.at(-1),
      };
    };
    const report = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      engine: `web-production-${settings.graphics.preset}`,
      build: JSON.parse(readFileSync(resolve(outputRoot, "benchmark-build.json"), "utf8")),
      map: spec.map,
      mapSHA256: sha256,
      mapBytes: bytes.length,
      contentRoot,
      nativeManifestPath,
      nativeContentFiles: nativeHashes.size,
      supplementalLocalContent,
      frames,
      warmup,
      screenshot,
      method:
        "Fixed camera world and optional floor weapons; core state refresh + world.update + graphicsPipeline.render; 60Hz visual time; sync selected by spec; batch includes final GPU completion; not presented FPS",
      requestedSettings: settings,
      ...result,
      submissionMs: result.samples.map((s) => s.submissionMs),
      wallMs: result.samples.map((s) => s.wallMs),
      finishMs: result.samples.map((s) => s.finishMs),
      readbackMs: result.samples.map((s) => s.readbackMs),
      statistics: {
        finishMs: summarize(result.samples.map((s) => s.finishMs)),
        readbackMs: summarize(result.samples.map((s) => s.readbackMs)),
        submissionMs: summarize(result.samples.map((s) => s.submissionMs)),
        wallMs: summarize(result.samples.map((s) => s.wallMs)),
      },
      missingFiles: [...missingFiles],
      blocked: [...blocked],
      errors,
    };
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        { out, screenshot, gpu: result.gpu, statistics: report.statistics, missingFiles: report.missingFiles, errors },
        null,
        2,
      ),
    );
    if (errors.length || result.glError) process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.stop(true);
}
