// Public, procedural collision fixtures. Uses the existing public BSP v20 writer;
// no production maps, replays, content cache, credentials or private code at runtime.
import { writeBsp, SURF_NOLIGHT, type Box, type MapSource, type Vec3 } from '../../../tools/tutorial/bsp';
export const FIXTURE_SUITE = 'rngfix-release-v1';
export const box = (min: Vec3, max: Vec3): Box => ({ min, max, tex: 'tools/toolsnodraw' });
function room(): MapSource {
  return {
    worldspawn: {},
    boxes: [box([-1024, -512, -512], [2048, 512, -480]), box([-1056, -544, -512], [-1024, 544, 1024]),
      box([2048, -544, -512], [2080, 544, 1024]), box([-1024, -544, -512], [2048, -512, 1024]),
      box([-1024, 512, -512], [2048, 544, 1024]), box([-1056, -544, 1024], [2080, 544, 1056])],
    materials: { 'tools/toolsnodraw': { width: 32, height: 32, reflectivity: [0.5, 0.5, 0.5], flags: SURF_NOLIGHT } },
    brushEntities: [], points: [{ classname: 'info_player_start', origin: '-800 0 300' }], seeds: [[-800, 0, 300]],
    lighting: { sunDir: [0, 0, -1], sun: [0, 0, 0], sky: [0, 0, 0], bounce: [0, 0, 0], luxel: 64, skyRays: 1 },
  };
}
export interface Trial { position: Vec3; velocity: Vec3; ticks: number; buttons: number }
export interface Fixture { name: string; bsp: Uint8Array; trials: Trial[] }
export function createFixtures(): Fixture[] {
  const incline = room();
  // 30 degree uphill wedge, including axial bounds; writer adds Source bevels.
  const s = 0.5, c = Math.sqrt(3) / 2;
  incline.solids = [{ sides: [
    { n: [-1, 0, 0], d: 0, tex: 'tools/toolsnodraw' }, { n: [1, 0, 0], d: 1500, tex: 'tools/toolsnodraw' },
    { n: [0, -1, 0], d: 400, tex: 'tools/toolsnodraw' }, { n: [0, 1, 0], d: 400, tex: 'tools/toolsnodraw' },
    { n: [0, 0, -1], d: 0, tex: 'tools/toolsnodraw' }, { n: [-s, 0, c], d: 0, tex: 'tools/toolsnodraw' },
  ] }];
  const edge = room(); edge.boxes.push(box([-1000, -400, -64], [0, 400, 0]));
  const pad = room(); pad.boxes.push(box([-400, -400, 96], [400, 400, 160]));
  pad.brushEntities.push({ keys: { classname: 'trigger_teleport', target: 'destination', spawnflags: '1' },
    boxes: [box([-64, -64, 160], [64, 64, 161])] });
  pad.points.push({ classname: 'info_teleport_destination', targetname: 'destination', origin: '1000 0 500', angles: '0 0 0' });
  // Starts are more than the restart API's 256-unit settling drop above the
  // landing surface. They therefore remain airborne; no new test-only ABI needed.
  const fall = (buttons: number): Trial[] => Array.from({ length: 40 }, (_, i) => ({
    position: [0, 0, 460 + i * 0.1], velocity: [0, 0, -300], ticks: 85, buttons,
  }));
  return [
    { name: 'incline', bsp: writeBsp(incline).bsp, trials: Array.from({ length: 60 }, (_, i) => ({
      position: [400, 0, 400 * (1 / Math.sqrt(3)) + 300 + i * 0.137], velocity: [400, 0, -300], ticks: 65, buttons: 0,
    })) },
    { name: 'edge', bsp: writeBsp(edge).bsp, trials: Array.from({ length: 80 }, (_, i) => ({
      // The 3-unit offset makes contact partway through a tick, spanning the edge.
      position: [-410 + i * 0.5, 0, 303], velocity: [800, 0, -400], ticks: 60, buttons: 2,
    })) },
    { name: 'thin-trigger', bsp: writeBsp(pad).bsp, trials: fall(2) },
    { name: 'telehop', bsp: writeBsp(pad).bsp, trials: fall(0) },
  ];
}
