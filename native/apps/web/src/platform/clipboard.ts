// The clipboard in the Wavedash build: the game's frame may not be allowed to write to it, so a refused
// navigator.clipboard.writeText (invite links, share links, settings codes) goes through Wavedash's copyLink, which
// copies on the host page and shows its own "copied" toast. Nothing changes on the site.

import { WAVEDASH } from "./env";
import { wavedashCopy } from "./wavedash";

export function installClipboard(): void {
  if (!WAVEDASH || typeof navigator === "undefined" || !navigator.clipboard) return;
  const clip = navigator.clipboard;
  const writeText = clip.writeText.bind(clip);
  clip.writeText = async (text: string): Promise<void> => {
    try {
      await writeText(text);
    } catch (e) {
      if (!(await wavedashCopy(text))) throw e;
    }
  };
}
