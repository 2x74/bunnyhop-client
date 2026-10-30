// The native menu's import boundary. Web modules that draw the game, run the simulation or load Three never enter
// the menu; native adapters stand in for the few web modules the menu's shared UI imports.
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { adaptSocialSource } from "./ui/adapt-social";
import { adaptSupportSource } from "./ui/adapt-support";
import { adaptCopySource, hasCopyFix } from "./ui/adapt-copy";

const root = resolve(import.meta.dir, "../..");
const native = resolve(import.meta.dir, "ui");
const web = resolve(root, "apps/web/src");

// UI style labels, settings and the jump-stats rows need these values, never Core or a WASM transport.
const coreConstantNames = [
  "PHYSICS_V1",
  "PHYSICS_V7",
  "PHYSICS_VERSION",
  "DEFAULT_SETTINGS",
  "OVERLAY_STATE_ACTIVE",
  "OVERLAY_STATE_VISIBLE",
  "WEAPON_IDS",
  "WEAPON_EVENT_DROPPED",
  "WEAPON_EVENT_GIVEN",
  "EVENT_TELEPORTED",
  "EVENT_JUMPED",
  "EVENT_LANDED",
];

// Web module (without extension) -> native adapter in ui/.
const adapters: Record<string, string> = {
  "gpu-info": "gpu-info.ts",
  "ui/account-panel": "account-panel.ts",
  audio: "audio.ts",
  "audio/index": "audio.ts",
  "audio/ui": "audio.ts",
  "audio/announcer": "audio.ts",
  "tutorial/entry": "tutorial-entry.ts",
  "player/race": "race-bus.ts",
  "play-lock": "play-lock.ts",
  hud: "hud-types.ts",
  // Only the command bits; importing the Input class or anything else from input.ts fails the build.
  input: "input-bits.ts",
  "net/hud": "chat-hud.ts",
  "ui/loadout-stage": "loadout-stage.ts",
  "notify/item3d": "item-emblem.ts",
  // The website's controls, with rows the native client can't honour left out (settings-controls.ts).
  "ui/controls": "settings-controls.ts",
  // Account sync with the native-only settings in the same document.
  "platform/settings-sync": "settings-sync.ts",
  // The Sky picker and Sky packs: the host keeps, fetches and decodes the skies (sky_library.cpp).
  "sky-packs/settings": "sky-settings.ts",
  // Cinematic's sky comes from the host; the menu downloads nothing into the browser.
  "graphics/cinematic-assets": "cinematic-assets.ts",
};
// Checked after the adapters: input stays forbidden apart from its command bits.
const forbiddenGameModules = ["main", "render", "session", "attract", "input"];
// Shared UI that navigates: it reads the menu's location instead of the page's.
const navigatingModules = ["ui/servers.ts", "net/lobby.ts", "social/state.ts", "social/dock.ts", "ui/gauntlets.ts"];

// Extract the exact declarations at build time so they cannot drift from web UI.
async function coreConstants(): Promise<string> {
  const source = await Bun.file(resolve(web, "core.ts")).text();
  return coreConstantNames
    .map((name) => {
      const match = source.match(new RegExp(`export const ${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*([\\s\\S]*?);`));
      if (!match) throw new Error(`Native menu constant extraction failed: ${name}`);
      return `export const ${name}=${match[1]};`;
    })
    .join("\n");
}

function resolveBoundary(args: Bun.OnResolveArgs): Bun.OnResolveResult | undefined {
  if (/^three(?:\/|$)/.test(args.path)) throw new Error(`Three is forbidden in the native menu: ${args.importer}`);
  if (!args.path.startsWith(".") && !isAbsolute(args.path)) return undefined;
  const target = resolve(dirname(args.importer), args.path);
  const webModule = relative(web, target).replace(/\.ts$/, "").replaceAll("\\", "/");
  if (webModule === "core") return { path: "native-menu-core-constants", namespace: "native-menu" };
  // An adapter that wraps its web module imports the module itself.
  const adapter = Object.hasOwn(adapters, webModule) ? resolve(native, adapters[webModule]) : null;
  if (adapter && adapter !== args.importer) return { path: adapter };
  if (forbiddenGameModules.includes(webModule)) {
    throw new Error(`Gameplay module is forbidden in the native menu: ${resolve(web, webModule)}`);
  }
  return undefined;
}

/** The settings screen renders each section inside settings-controls.ts renderingSection, so rows know their section. */
function adaptSettingsPanel(source: string): string {
  const call = "content = d.s.render(ctxFor(d));";
  if (!source.includes(call))
    throw new Error("Native menu: web settings-panel.ts no longer renders sections as expected");
  const controls = JSON.stringify(resolve(native, "settings-controls.ts"));
  const wrapped = source.replace(call, "content = renderingSection(d.s.id, () => d.s.render(ctxFor(d)));");
  return `import {renderingSection} from ${controls};\n${wrapped}`;
}

/**
 * The jump-stats rows come with the website's !ssj, which opens a web popover. The native client registers its own
 * !ssj (chat-service.ts: the host toggles the jump HUD), so the website's registration stays out of the menu.
 */
function adaptJumpStats(source: string): string {
  const registration = /^registerChatCommand\(\{ name: "ssj",.*\}\);$/m;
  if (!registration.test(source)) throw new Error("Native menu: web ssj/index.ts no longer registers !ssj as expected");
  return source.replace(registration, "");
}

async function adaptedSource(path: string): Promise<string | null> {
  const webFile = relative(web, path).replaceAll("\\", "/");
  if (hasCopyFix(webFile)) return adaptCopySource(webFile, await Bun.file(path).text());
  if (webFile === "ui/settings-panel.ts") return adaptSettingsPanel(await Bun.file(path).text());
  if (webFile === "ssj/index.ts") return adaptJumpStats(await Bun.file(path).text());
  if (webFile === "ui/support.ts") {
    const support = await Bun.file(path).text();
    return adaptSupportSource(support, resolve(native, "support-checkout.ts"), resolve(native, "bridge.ts"));
  }
  if (!navigatingModules.includes(webFile)) return null;
  let source = await Bun.file(path).text();
  if (webFile === "social/state.ts") source = adaptSocialSource(source);
  if (webFile === "social/dock.ts") source += `\nwindow.addEventListener("bunnyhop:account",()=>close());`;
  const navigation = JSON.stringify(resolve(native, "navigation.ts"));
  return `import {nativeLocation as location} from ${navigation};\n${source}`;
}

/** Bundler plugin for anything built into the native menu. `modules` collects every source file loaded. */
export async function nativeMenuBoundary(modules = new Set<string>()): Promise<Bun.BunPlugin> {
  const constants = await coreConstants();
  return {
    name: "native-menu-boundary",
    setup(build) {
      build.onResolve({ filter: /./ }, resolveBoundary);
      build.onLoad({ filter: /.*/, namespace: "native-menu" }, () => ({ contents: constants, loader: "ts" }));
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        modules.add(args.path);
        const contents = await adaptedSource(args.path);
        if (contents === null) return undefined;
        return { contents, loader: "ts", resolveDir: dirname(args.path) };
      });
    },
  };
}
