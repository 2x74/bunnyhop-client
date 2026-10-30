// The website's Cinematic downloads (web graphics/cinematic-assets.ts) for the native menu. The website installs its
// sky and material packs into the browser; the native client fetches the Cinematic sky itself when the look draws it
// (sky_library.cpp), and texture packs aren't part of the native renderer, so the menu downloads nothing here.

export interface CinematicAssets {
  skyPackId: "cloudy-day";
  status: string;
  restore: () => Promise<void>;
}

export async function ensureCinematicAssets(signal: AbortSignal): Promise<CinematicAssets> {
  signal.throwIfAborted();
  return { skyPackId: "cloudy-day", status: "", restore: restoreCinematicAssets };
}

export async function restoreCinematicAssets(): Promise<void> {}
