import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { buildSettingsDoc, encodeSettingsCode } from "../../web/src/ui/settings-io";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";
import { importSummary } from "./settings-transfer-panel";

// Settings -> Import / export through the host's file dialogs. The host is
// played by the page: it answers each `file` message with a native-file event.

interface FileMessage {
  type: string;
  action?: string;
  purpose?: string;
  id?: string;
  text?: string;
  name?: string;
  patch?: { sensitivity?: number };
}

const PAGE = "https://bunnyhop.lol/settings-file";

async function openTransfer(page: Page): Promise<void> {
  const html = await readFile(new URL("../../../target/native-menu/menu.html", import.meta.url), "utf8");
  await page.route("**/*", (route) => {
    if (route.request().url() !== PAGE) return route.abort();
    return route.fulfill({ contentType: "text/html", body: html });
  });
  await page.addInitScript(() => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    const sent: unknown[] = [];
    Object.assign(window, { sent });
    window.addEventListener("bunnyhop:native-message", (event) => sent.push((event as CustomEvent).detail));
  });
  await page.goto(PAGE);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('.nset-rail-item[data-section="transfer"]').click();
}

function sent(page: Page, type: string): Promise<FileMessage[]> {
  return page.evaluate((wanted) => {
    const messages = (window as unknown as { sent: FileMessage[] }).sent;
    return messages.filter((message) => message.type === wanted);
  }, type);
}

async function lastFileMessage(page: Page): Promise<FileMessage> {
  await page.waitForFunction(() => (window as unknown as { sent: FileMessage[] }).sent.some((m) => m.type === "file"));
  return (await sent(page, "file")).at(-1)!;
}

/** The host's answer to `request`. */
async function answer(page: Page, request: FileMessage, result: Record<string, unknown>): Promise<void> {
  const detail = { id: request.id, purpose: request.purpose, action: request.action, cancelled: false, ...result };
  await page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent("bunnyhop:native-file", { detail: value }));
  }, detail);
}

test("import summary copy", () => {
  expect(importSummary(1, [])).toBe("Imported 1 setting.");
  const summary = importSummary(12, ["web HUD anchors/layout"]);
  expect(summary).toBe("Imported 12 settings. Not imported: web HUD anchors/layout.");
});

test("a settings file loads into the box, applies with one press, and saves through the host", async () => {
  const code = await encodeSettingsCode(buildSettingsDoc({ ...DEFAULT_PREFS, sensitivity: 2.75 }));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openTransfer(page);

    // Load: the host's open dialog answers with the file's text.
    await page.getByRole("button", { name: "Load .json file…", exact: true }).click();
    const open = await lastFileMessage(page);
    expect(open).toMatchObject({ action: "open", purpose: "settings" });
    await answer(page, open, { ok: true, name: "mine.txt", text: code });
    await page.getByText("Loaded mine.txt. Press Apply to use it.").waitFor();
    expect(await page.getByLabel("Settings code or JSON").inputValue()).toBe(code);

    // Nothing changes until Apply.
    expect(await sent(page, "settings")).toEqual([]);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByText(/^Imported \d+ settings\./).waitFor();
    const applied = (await sent(page, "settings")).at(-1);
    expect(applied?.patch?.sensitivity).toBe(2.75);

    // Errors from the host are shown as they are; a cancelled dialog says nothing.
    await page.getByRole("button", { name: "Load .json file…", exact: true }).click();
    const second = await lastFileMessage(page);
    await answer(page, second, { ok: false, error: "The file is larger than 1024 KB." });
    await page.getByText("The file is larger than 1024 KB.").waitFor();

    // Save: the host gets the export and a dated file name.
    await page.getByRole("button", { name: "Save .json file…", exact: true }).click();
    const save = await lastFileMessage(page);
    expect(save).toMatchObject({ action: "save", purpose: "settings" });
    expect(save.name).toMatch(/^bunnyhop-settings-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(save.text!).format).toBe("bunnyhop-native-settings");
    await answer(page, save, { ok: true, name: save.name });
    await page.getByText(`Saved ${save.name}.`).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30000);
