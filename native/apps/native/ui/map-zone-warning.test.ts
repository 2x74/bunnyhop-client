import { test, expect } from "bun:test";
import { MapZoneWarning } from "./map-zone-warning";

const labels: Record<string, string> = {
  bhop_end: "End zone unconfirmed",
  bhop_bonus: "Bonus zones incomplete",
};

function warning() {
  const said: string[] = [];
  const zones = new MapZoneWarning(
    async (map) => labels[map],
    (text) => said.push(text),
  );
  return { said, zones };
}

test("a map's label is said once when it loads, and again on coming back to it", async () => {
  const { said, zones } = warning();
  zones.mapChanged("bhop_end");
  zones.mapChanged("bhop_end");
  await Bun.sleep(0);
  expect(said).toEqual(["End zone unconfirmed: your run may not finish where the map seems to end."]);
  zones.mapChanged(null);
  zones.mapChanged("bhop_end");
  await Bun.sleep(0);
  expect(said).toHaveLength(2);
});

test("bonus labels have their own line, and fine maps say nothing", async () => {
  const { said, zones } = warning();
  zones.mapChanged("bhop_fine");
  zones.mapChanged("bhop_bonus");
  await Bun.sleep(0);
  expect(said).toEqual(["Bonus zones incomplete: a bonus run here can't finish."]);
});

test("a map left before its label arrives says nothing, and a failed lookup is quiet", async () => {
  const said: string[] = [];
  const zones = new MapZoneWarning(
    async (map) => {
      if (map === "bhop_broken") throw new Error("offline");
      return labels[map];
    },
    (text) => said.push(text),
  );
  zones.mapChanged("bhop_end");
  zones.mapChanged("bhop_broken");
  await Bun.sleep(0);
  expect(said).toEqual([]);
});
