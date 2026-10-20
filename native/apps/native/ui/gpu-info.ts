// API device identity still uses the existing cookie/ID/2D fingerprint code.
// This menu has no game canvas or GPU capabilities to report and never probes WebGL.
export function gpuInfo(_fallback = false): null { return null; }
export function glCaps(): string { return ""; }
