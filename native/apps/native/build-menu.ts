// The embedded WKWebView loads exactly this one menu document. No web-game
// entry point, Three module, renderer, WASM asset or network script is permitted.
import { mkdir, writeFile } from "node:fs/promises";
import { adaptSocialSource } from "./ui/adapt-social";
import { dirname, resolve, relative } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "../..");
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string", default: resolve(root,"target/native-menu/menu.html") } } });
const out = resolve(values.out!);
const modules = new Set<string>();
const native = resolve(import.meta.dir,"ui");
const web = resolve(root,"apps/web/src");
// UI style labels/settings need these values, never Core or a WASM transport.
// Extract the exact declarations at build time so they cannot drift from web UI.
const coreSource = await Bun.file(resolve(web,"core.ts")).text();
const constantNames = ["PHYSICS_V1","PHYSICS_V7","PHYSICS_VERSION","DEFAULT_SETTINGS","OVERLAY_STATE_ACTIVE","OVERLAY_STATE_VISIBLE"];
const coreConstants = constantNames.map(name=>{
  const match=coreSource.match(new RegExp(`export const ${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*([\\s\\S]*?);`));
  if(!match) throw new Error(`Native menu constant extraction failed: ${name}`);
  return `export const ${name}=${match[1]};`;
}).join("\n");
const result = await Bun.build({
  entrypoints: [resolve(native,"main.ts")], target: "browser", format: "iife", splitting: false,
  minify: true, sourcemap: "none",
  define: { "import.meta.env.VITE_API_URL": JSON.stringify("/api"), "import.meta.env.DEV": "false", "import.meta.env": JSON.stringify({VITE_API_URL:"/api",DEV:false}) },
  // Bun supports dataurl at runtime; bun-types 1.4.3 omits this loader literal.
  loader: { ".svg": "dataurl" as Bun.Loader, ".png": "dataurl" as Bun.Loader, ".webp": "dataurl" as Bun.Loader, ".woff2": "dataurl" as Bun.Loader },
  plugins: [{ name: "native-menu-boundary", setup(build) {
    build.onResolve({filter: /./}, (args) => {
      if (/^three(?:\/|$)/.test(args.path)) throw new Error(`Three is forbidden in the native menu: ${args.importer}`);
      const path = args.path.startsWith(".") ? resolve(dirname(args.importer),args.path).replace(/\.ts$/,"") : args.path;
      if(path===resolve(web,"core")) return {path:"native-menu-core-constants",namespace:"native-menu"};
      const adapters: Record<string,string> = {
        [resolve(web,"gpu-info")]: "gpu-info.ts",
        [resolve(web,"ui/account-panel")]: "account-panel.ts",
        [resolve(web,"audio")]: "audio.ts",
        [resolve(web,"audio/index")]: "audio.ts",
        [resolve(web,"audio/ui")]: "audio.ts",
        [resolve(web,"tutorial/entry")]: "tutorial-entry.ts",
        [resolve(web,"player/race")]: "race-bus.ts",
      };
      if(adapters[path]) return {path:resolve(native,adapters[path])};
      if (["main","render","session","attract","input"].some(name=>path===resolve(web,name))) throw new Error(`Gameplay module is forbidden in the native menu: ${path}`);
    });
    build.onLoad({filter:/.*/,namespace:"native-menu"},()=>({contents:coreConstants,loader:"ts"}));
    build.onLoad({filter:/\.[cm]?[jt]sx?$/}, async (args) => {
      modules.add(args.path);
      if(["ui/servers.ts","net/lobby.ts","social/state.ts","social/dock.ts"].some(path=>args.path===resolve(web,path))) {
        let source=await Bun.file(args.path).text();
        if(args.path===resolve(web,"social/state.ts"))source=adaptSocialSource(source);
        if(args.path===resolve(web,"social/dock.ts"))source+=`\nwindow.addEventListener("bunnyhop:account",()=>close());`;
        return {contents:`import {nativeLocation as location} from ${JSON.stringify(resolve(native,"navigation.ts"))};\n${source}`,loader:"ts",resolveDir:dirname(args.path)};
      }
      return undefined;
    });
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
const scripts: string[] = [], styles: string[] = [];
for(const output of result.outputs) {
  if(output.path.endsWith(".js")) scripts.push(await output.text());
  else if(output.path.endsWith(".css")) styles.push(await output.text());
  else throw new Error(`Menu asset was not inlined: ${output.path}`);
}
if(scripts.length!==1) throw new Error(`Expected one inline menu script; got ${scripts.length}`);
// Bun preserves CSS url() references. Embed the existing country flag SVGs too,
// rather than asking WKWebView to load a local directory or a network stylesheet.
for(let index=0;index<styles.length;index++) {
  const urls=[...new Set([...styles[index].matchAll(/url\(["']?(\.\.\/flags\/[\w/.-]+\.svg)["']?\)/g)].map(match=>match[1]))];
  const images=await Promise.all(urls.map(async path=>[path,`data:image/svg+xml;base64,${Buffer.from(await Bun.file(resolve(dirname(Bun.resolveSync("flag-icons/package.json",root)),"css",path)).arrayBuffer()).toString("base64")}`] as const));
  for(const [path,data] of images) styles[index]=styles[index].replaceAll(path,data);
  for(const match of styles[index].matchAll(/url\(([^)]*)\)/g)) {
    const url=match[1].trim().replace(/^["']|["']$/g,"");
    if(!/^(?:data:|#|https:)/.test(url)) throw new Error(`Menu stylesheet contains an external asset: ${url}`);
  }
}
const prelude = `window.__nativeMenuGraphics={contexts:0,attempts:0};(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(/webgl|experimental-webgl/i.test(type)){window.__nativeMenuGraphics.attempts++;return null;}return original.call(this,type,...args);};})();`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="https://bunnyhop.lol/"><title>bunnyhop.lol</title><style>${styles.join("\n").replaceAll("</style","<\\/style")}</style></head><body class="native-menu menu-open"><div class="native-shell"><header class="native-top"><div class="wordmark wordmark-sm" aria-label="bunnyhop.lol">bunnyhop.lol</div><div id="native-account"></div></header><main id="native-menu"></main><p id="native-status" role="status"></p><p id="native-notice" role="status"></p><footer class="native-footer"><span>Esc menu</span><span>WASD · Space / wheel · Ctrl</span></footer></div><script>${prelude}</script><script>${scripts[0].replaceAll("</script","<\\/script")}</script></body></html>`;
await mkdir(dirname(out),{recursive:true}); await writeFile(out,html);
await writeFile(resolve(dirname(out),"menu-manifest.json"),JSON.stringify({html:out,bytes:Buffer.byteLength(html),webGameEntry:false,three:false,modules:[...modules].sort().map(path=>relative(root,path))},null,2)+"\n");
console.log(`Native menu: ${out} (${Buffer.byteLength(html).toLocaleString()} bytes, ${modules.size} source modules, no Three/game entry)`);
