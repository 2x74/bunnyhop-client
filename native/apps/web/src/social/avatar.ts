import type { ApiPlayer } from "../api";
import { avatarImg, pictureOf } from "../ui/avatar";
import { hueOf } from "../ui/board-pager";
import { h } from "../ui/dom";

/** A player's avatar for the friends dock and social notices: their picture, else their initial on a hue of their id. */
export function avatar(p: Pick<ApiPlayer, "id" | "name" | "avatarUrl">, px = 28): HTMLElement {
  const letter = () => h("span.fd-av", { "aria-hidden": "true", style: `--hue:${hueOf(p.id)}` }, (p.name.trim()[0] ?? "?").toUpperCase());
  const pic = pictureOf(p);
  return pic ? avatarImg(pic, { cls: "fd-av", px, letter }) : letter();
}
