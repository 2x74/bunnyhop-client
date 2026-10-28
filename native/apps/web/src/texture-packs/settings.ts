import { h } from "../ui/dom";
import { registerSettingsSection } from "../ui/settings-registry";
import { downloadPack, enablePack, installedPacks, installPack, removePack, watchTexturePacks, type InstalledPack } from "./store";
import { PACK_LIMITS } from "./manifest";
let records: InstalledPack[] = []; let status = "Loading installed packs…"; let loaded = false;
let controller: AbortController | null = null;
function savePack(pack: InstalledPack): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack.pack)], { type: "application/json" }));
  const link = h("a", { href: url, download: `${pack.pack.id}.bhpack.json` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
registerSettingsSection("texture-packs", (ui, ctx) => {
  const reload = async () => { records = await installedPacks(); loaded = true; ctx.refresh(); };
  if (!loaded) { loaded = true; watchTexturePacks(()=>void reload()); void reload().catch((error) => { status = String(error); ctx.refresh(); }); }
  const run = async (operation: () => Promise<void>, downloading = false) => {
    try { await operation(); status = "Saved. Changes apply on the next map load; your current run continues."; await reload(); }
    catch (error) { status = controller?.signal.aborted ? "Download cancelled." : String((error as Error).message ?? error); ctx.refresh(); }
    finally { if (downloading) controller = null; ctx.refresh(); }
  };
  const file = h("input", { type: "file", accept: ".bhpack.json,application/json", hidden: true, onchange: () => {
    const selected = file.files?.[0]; if (!selected) return;
    void run(async () => { if (selected.size > PACK_LIMITS.file) throw new Error("Pack file exceeds budget"); await installPack(JSON.parse(await selected.text())); });
  } });
  const url = h("input", { type: "url", placeholder: "https://…/pack.bhpack.json", "aria-label": "Texture pack manifest URL" });
  const download = (address: string) => {
    if (controller) return; controller = new AbortController(); status = "Downloading…"; ctx.refresh();
    void run(() => downloadPack(address, controller!.signal, (bytes, total) => { status = `Downloading ${(bytes / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ""}`; ctx.refresh(); }), true);
  };
  const message = h("p", null, status);
  const storage = h("small", null, "Checking browser storage…");
  void navigator.storage?.estimate().then(({ usage, quota }) => { storage.textContent = `Browser storage: ${((usage ?? 0) / 1048576).toFixed(1)} MB used / ${((quota ?? 0) / 1048576).toFixed(0)} MB available`; });
  return { columns: [[ui.group("Install", file, ui.actions("Portable pack", [ui.button("Import .bhpack.json", () => file.click(), { disabled: !!controller }), ui.button("Download color demo", () => download("/texture-packs/original-demo.bhpack.json"), { disabled: !!controller }), ui.button("Download material demo", () => download("/texture-packs/original-pbr-demo.bhpack.json"), { disabled: !!controller }), ui.button("Download Ambience materials", () => download("/texture-packs/ambience-materials.bhpack.json"), { disabled: !!controller })], { desc: "Versioned portable packs contain verified PNG, WebP or KTX2/Basis color, normal and roughness replacements. Normal/roughness response uses Enhanced/Cinematic with an authored sun. Imported packs start disabled. Enable them below, then load a map." }), ui.row("Pack URL", url), ui.actions("Download", [ui.button("Download URL", () => download(url.value), { disabled: !!controller }), ui.button("Cancel", () => controller?.abort(), { disabled: !controller })]), message, storage)], [ui.group("Installed packs", ...(records.length ? records.map((record) => h("div", null, ui.toggle(`${record.pack.name} · ${record.pack.version}`, () => record.enabled, (enabled) => void run(() => enablePack(record.pack.id, enabled)), { desc: `${record.pack.entries.length} mappings. Later installs have priority. Changes apply on the next map load. Material alpha, UVs and physics retain map behavior.` }), ui.actions(record.pack.id, [ui.button("Export pack", () => savePack(record)), ui.button("Remove", () => void run(() => removePack(record.pack.id)))]))) : [h("p", null, "No texture packs installed.")]))]] };
}, { advancedUnder: "graphics", label: "Texture packs", icon: "graphics", order: 75, blurb: "Optional visual replacements. Install, enable, then load a map. Original materials remain the fallback." });
