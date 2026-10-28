// First import of the game (main.ts): in the Wavedash build, teaches fetch / WebSocket the cookie tunnel and points
// site paths and images at bunnyhop.lol (jar.ts, images.ts) before any other module runs. Nothing on the site.
// Only tiny dependencies here, so nothing else is evaluated before the patches are in.

import { WAVEDASH } from "./env";
import { installClipboard } from "./clipboard";
import { installImages } from "./images";
import { installJar } from "./jar";
import { installNavigation } from "./navigation";
import { wavedashProgress } from "./wavedash";

if (WAVEDASH) {
  installJar();
  installImages();
  installNavigation();
  installClipboard();
  wavedashProgress(0.05);
}
