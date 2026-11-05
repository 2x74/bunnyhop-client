import type { ApiPlayer } from "../api";
import { avatarImg, pictureOf } from "../ui/avatar";
import { hueOf } from "../ui/board-pager";
import { h } from "../ui/dom";
import { decorated } from "../ui/avatar-deco";

/** A player's avatar for the friends dock and social notices: their picture, else their initial on a hue of their id. */
export function avatar(p: Pick<ApiPlayer, "id" | "name" | "avatarUrl"> & Partial<Pick<ApiPlayer, "avatarDeco" | "nameColor">>, px = 28): HTMLElement {
  const letter = () => h("span.fd-av", { "aria-hidden": "true", style: `--hue:${hueOf(p.id)}` }, (p.name.trim()[0] ?? "?").toUpperCase());
  const pic = pictureOf(p);
  // A supporter's decoration, still (ui/avatar-deco.ts).
  return decorated(pic ? avatarImg(pic, { cls: "fd-av", px, letter }) : letter(), p);
}
