import { h } from "../ui/dom";
import { registerSettingsSection } from "../ui/settings-registry";
import { downloadPack, enablePack, installedPacks, installPack, removePack, watchTexturePacks, type InstalledPack } from "./store";
import { PACK_LIMITS } from "./manifest";
let records: InstalledPack[] = []; let status = ""; let loaded = false;
let controller: AbortController | null = null;
/** The status line on screen: download progress updates it in place instead of re-rendering Graphics. */
let messageNode: HTMLElement | null = null;
function savePack(pack: InstalledPack): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack.pack)], { type: "application/json" }));
  const link = h("a", { href: url, download: `${pack.pack.id}.bhpack.json` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
registerSettingsSection("texture-packs", (ui, ctx) => {
  const reload = async () => { records = await installedPacks(); loaded = true; ctx.refresh(); };
  if (!loaded) { loaded = true; watchTexturePacks(()=>void reload()); void reload().catch((error) => { status = String(error); ctx.refresh(); }); }
  const run = async (operation: () => Promise<void>, downloading = false) => {
    try { await operation(); status = "Saved. Changes show from the next map."; await reload(); }
    catch (error) { status = controller?.signal.aborted ? "Download cancelled." : String((error as Error).message ?? error); ctx.refresh(); }
    finally { if (downloading) controller = null; ctx.refresh(); }
  };
  const file = h("input", { type: "file", accept: ".bhpack.json,application/json", hidden: true, onchange: () => {
    const selected = file.files?.[0]; if (!selected) return;
    void run(async () => { if (selected.size > PACK_LIMITS.file) throw new Error("Pack file exceeds budget"); await installPack(JSON.parse(await selected.text())); });
  } });
  const url = h("input.text-input", { type: "url", placeholder: "https://…/pack.bhpack.json", "aria-label": "Texture pack link", spellcheck: false });
  const download = (address: string) => {
    if (controller) return; controller = new AbortController(); status = "Downloading…"; ctx.refresh();
    void run(() => downloadPack(address, controller!.signal, (bytes, total) => { status = `Downloading ${(bytes / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ""}`; if (messageNode) messageNode.textContent = status; }), true);
  };
  const message = (messageNode = h("p.set-note", { role: "status", hidden: !status }, status));
  const storage = h("p.set-note", { hidden: true });
  void navigator.storage?.estimate().then(({ usage, quota }) => { storage.textContent = `Browser storage: ${((usage ?? 0) / 1048576).toFixed(1)} MB used of ${((quota ?? 0) / 1048576).toFixed(0)} MB`; storage.hidden = false; });
  const busy = !!controller;
  return [
    ui.group("Texture packs",
      ui.actions("Examples", [ui.button("Colour demo", () => download("/texture-packs/original-demo.bhpack.json"), { disabled: busy }), ui.button("Material demo", () => download("/texture-packs/original-pbr-demo.bhpack.json"), { disabled: busy }), ui.button("Ambience materials", () => download("/texture-packs/ambience-materials.bhpack.json"), { disabled: busy })], { desc: "Download an example pack (6, 15 and 1.5 MB). Material packs need the Enhanced or Cinematic look and a map with a sun.", keywords: "texture pack demo example material download" }),
      ui.row("Add from a link", h("div.set-link", null, url, ui.button(busy ? "Cancel" : "Download", () => (busy ? controller?.abort() : download(url.value)))), { desc: "A link to a .bhpack.json texture pack.", keywords: "texture pack url link download" }),
      ui.row("Pack file", h("div.btn-row", null, file, ui.button("Import .bhpack.json", () => file.click(), { disabled: busy })), { desc: "Packs hold PNG, WebP or KTX2 colour, normal and roughness replacements. New packs start off: turn them on below, then load a map.", keywords: "texture pack import file bhpack" }),
      message,
      ...records.map((record) => ui.toggle(`${record.pack.name} · ${record.pack.version}`, () => record.enabled, (enabled) => void run(() => enablePack(record.pack.id, enabled)), { desc: `${record.pack.entries.length} textures. Packs installed later win. Changes apply on the next map load.`, keywords: "installed texture pack enable" })),
      ...records.map((record) => ui.actions(record.pack.name, [ui.button("Save", () => savePack(record)), ui.button("Remove", () => void run(() => removePack(record.pack.id)))], { keywords: "installed texture pack remove delete save export" })),
      storage,
    ),
  ];
}, { advancedUnder: "graphics", label: "Texture packs", icon: "graphics", order: 75 });
