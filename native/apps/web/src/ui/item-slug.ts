// Menu entries' data-item (ui/home.ts, menu.ts rail items): a hook custom CSS may rely on (/custom-css), the label in
// lower case with dashes. Renaming a label? Keep its old data-item.

/** "Play online" -> "play-online". */
export const itemSlug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
