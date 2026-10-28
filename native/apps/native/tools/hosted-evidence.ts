import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";
const crc = (d: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of d) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (n: string, d: Buffer) => {
  let h = Buffer.alloc(4),
    c = Buffer.alloc(4),
    t = Buffer.from(n);
  h.writeUInt32BE(d.length);
  c.writeUInt32BE(crc(Buffer.concat([t, d])));
  return Buffer.concat([h, t, d, c]);
};
const names = ["hosted-idle", "hosted-run", "hosted-fire", "hosted-inspect"],
  images = [];
for (const name of names) {
  const b = await readFile(`/tmp/bunnyhop-hosted-render-evidence/${name}.rgba`),
    head = Buffer.alloc(13);
  head.writeUInt32BE(512);
  head.writeUInt32BE(384, 4);
  head[8] = 8;
  head[9] = 6;
  const scan = Buffer.alloc(384 * 2049);
  for (let y = 0; y < 384; y++) b.copy(scan, y * 2049 + 1, y * 2048, (y + 1) * 2048);
  images.push(
    "data:image/png;base64," +
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", head),
        chunk("IDAT", deflateSync(scan)),
        chunk("IEND", Buffer.alloc(0)),
      ]).toString("base64"),
  );
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 540 } });
  await page.setContent(
    "<style>body{margin:0;background:#101725;color:white;font:16px sans-serif}h2{margin:18px}main{display:flex}figure{margin:10px;width:300px;text-align:center}canvas{width:280px;height:430px;object-fit:contain}</style><h2>Actual C++ native captures · hosted Source animation rig</h2><main></main>",
  );
  await page.evaluate(
    async ({ images, names }) => {
      for (let n = 0; n < images.length; n++) {
        let im = new Image();
        im.src = images[n];
        await im.decode();
        let source = document.createElement("canvas");
        source.width = 512;
        source.height = 384;
        let ctx = source.getContext("2d")!;
        ctx.drawImage(im, 0, 0);
        let p = ctx.getImageData(0, 0, 512, 384).data,
          x0 = 512,
          y0 = 384,
          x1 = 0,
          y1 = 0;
        for (let y = 0; y < 384; y++)
          for (let x = 0; x < 512; x++)
            if (p[(y * 512 + x) * 4 + 3] > 5) {
              x0 = Math.min(x0, x);
              y0 = Math.min(y0, y);
              x1 = Math.max(x1, x);
              y1 = Math.max(y1, y);
            }
        let c = document.createElement("canvas");
        c.width = x1 - x0 + 1;
        c.height = y1 - y0 + 1;
        c.getContext("2d")!.drawImage(im, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
        let f = document.createElement("figure"),
          caption = document.createElement("figcaption");
        caption.textContent = names[n];
        f.append(c, caption);
        document.querySelector("main")!.append(f);
      }
    },
    { images, names },
  );
  await page.screenshot({ path: "/tmp/native-040-visuals/native-hosted-animations-contact.png" });
} finally {
  await browser.close();
}
