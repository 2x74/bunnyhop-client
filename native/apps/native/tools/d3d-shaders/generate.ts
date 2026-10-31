import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writePlayerMaterials } from "../../src/export-player-materials";
import { FINISH_STYLE } from "../../../web/src/loadout";
import { FINISH_CODE } from "../../../web/src/viewmodel/finishes/shader";

const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
await writePlayerMaterials(directory);
const finishes = [...new Set(Object.values(FINISH_STYLE).map((finish) => FINISH_CODE[finish.kind]))].sort(
  (a, b) => a - b,
);
await writeFile(resolve(directory, "finishes.json"), JSON.stringify(finishes) + "\n");
