import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWarnings, chooseDisplay, publicDisplays } from '../diagnostics.mjs';

const displays = [
  { id: 1, label: 'Slow', displayFrequency: 60, scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, label: 'Fast', displayFrequency: 240, scaleFactor: 1, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
];

test('display choice respects an exact display and the highest-refresh preference', () => {
  assert.equal(chooseDisplay(displays, { preferredDisplay: 'display:1', preferHighestRefresh: false }, displays[0]).id, 1);
  assert.equal(chooseDisplay(displays, { preferredDisplay: 'primary', preferHighestRefresh: true }, displays[0]).id, 2);
  assert.equal(chooseDisplay(displays, { preferredDisplay: 'display:999', preferHighestRefresh: false }, displays[0]).id, 1);
});

test('public display facts contain no native Electron objects', () => {
  assert.deepEqual(publicDisplays(displays)[1], {
    id: '2', label: 'Fast', primary: false, frequency: 240, scaleFactor: 1,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
  });
});

test('diagnostics call out low refresh, scaling, software GPU, and RDP', () => {
  const warnings = buildWarnings({
    displays,
    selectedDisplay: displays[0],
    gpuFeatureStatus: { gpu_compositing: 'disabled_software' },
    gpuInfo: {},
    env: { SESSIONNAME: 'RDP-Tcp#4' },
  });
  const codes = warnings.map((warning) => warning.code);
  assert.ok(codes.includes('low-refresh'));
  assert.ok(codes.includes('fractional-scale'));
  assert.ok(codes.includes('software-gpu'));
  assert.ok(codes.includes('remote-session'));
});
