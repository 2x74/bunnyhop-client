function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function publicDisplays(displays = []) {
  return displays.map((display) => ({
    id: String(display.id),
    label: display.label || `Display ${display.id}`,
    primary: Boolean(display.primary),
    frequency: finite(display.displayFrequency),
    scaleFactor: finite(display.scaleFactor, 1),
    bounds: {
      x: finite(display.bounds?.x),
      y: finite(display.bounds?.y),
      width: finite(display.bounds?.width),
      height: finite(display.bounds?.height),
    },
    workArea: {
      x: finite(display.workArea?.x),
      y: finite(display.workArea?.y),
      width: finite(display.workArea?.width),
      height: finite(display.workArea?.height),
    },
  }));
}

export function chooseDisplay(displays, settings, primaryDisplay) {
  if (!displays.length) return primaryDisplay ?? null;
  if (settings.preferredDisplay.startsWith('display:')) {
    const id = settings.preferredDisplay.slice('display:'.length);
    const exact = displays.find((display) => String(display.id) === id);
    if (exact) return exact;
  }
  if (settings.preferredDisplay === 'highest-refresh' || settings.preferHighestRefresh) {
    return [...displays].sort((a, b) => finite(b.displayFrequency) - finite(a.displayFrequency))[0];
  }
  return primaryDisplay ?? displays[0];
}

export function buildWarnings({ displays = [], selectedDisplay = null, gpuFeatureStatus = {}, gpuInfo = {}, env = process.env } = {}) {
  const warnings = [];
  const frequency = finite(selectedDisplay?.displayFrequency);
  if (frequency > 0 && frequency < 120) {
    warnings.push({ code: 'low-refresh', level: 'warning', text: `Selected display is ${frequency} Hz. Use the highest refresh rate available.` });
  }
  if (selectedDisplay && finite(selectedDisplay.scaleFactor, 1) !== 1) {
    warnings.push({ code: 'fractional-scale', level: 'info', text: `Display scaling is ${Math.round(selectedDisplay.scaleFactor * 100)}%. Test device-scale pinning if the canvas is resampled.` });
  }
  const featureValues = Object.values(gpuFeatureStatus);
  if (featureValues.some((value) => String(value).includes('software'))) {
    warnings.push({ code: 'software-gpu', level: 'error', text: 'Chromium reports a software GPU path. Do not benchmark this configuration.' });
  }
  if (/^rdp/i.test(env.SESSIONNAME || '')) {
    warnings.push({ code: 'remote-session', level: 'error', text: 'Remote Desktop is active. Raw motion and presentation results are not representative.' });
  }
  const devices = gpuInfo?.gpuDevice || gpuInfo?.auxAttributes?.gpuDevice || [];
  if (Array.isArray(devices) && devices.length > 1 && !devices.some((device) => device.active)) {
    warnings.push({ code: 'gpu-unknown', level: 'info', text: 'Multiple GPUs were found, but Chromium did not identify the active adapter.' });
  }
  if (!warnings.length) warnings.push({ code: 'no-obvious-problem', level: 'ok', text: 'No obvious display or GPU problem was detected. This is not a latency measurement.' });
  return warnings;
}

export async function collectDiagnostics({ app, screen, settings, env = process.env }) {
  const displays = screen.getAllDisplays();
  const selected = chooseDisplay(displays, settings, screen.getPrimaryDisplay());
  let gpuInfo = null;
  let gpuError = null;
  try {
    gpuInfo = await app.getGPUInfo('complete');
  } catch (error) {
    gpuError = error.message;
  }
  const gpuFeatureStatus = app.getGPUFeatureStatus();
  return {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    clientVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    architecture: process.arch,
    settings,
    displays: publicDisplays(displays),
    selectedDisplay: selected ? String(selected.id) : null,
    gpuFeatureStatus,
    gpuInfo,
    gpuError,
    warnings: buildWarnings({ displays, selectedDisplay: selected, gpuFeatureStatus, gpuInfo, env }),
    note: 'This report finds configuration problems. Camera or LDAT data is still required for an input-to-photon claim.',
  };
}
