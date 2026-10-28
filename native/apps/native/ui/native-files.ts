import { send } from "./bridge";

// Files through the host's system dialogs (menu_files.hpp). The host reads and
// writes them; the menu only gets their text and name.

export type FilePurpose = "settings" | "css";

export interface FileAnswer {
  id: string;
  purpose: FilePurpose;
  action: "open" | "save";
  ok: boolean;
  cancelled: boolean;
  name?: string;
  text?: string;
  error?: string;
}

let nextId = 0;

interface FileRequest {
  action: "open" | "save";
  purpose: FilePurpose;
  text?: string;
  name?: string;
}

function request(message: FileRequest): Promise<FileAnswer> {
  const id = `file-${++nextId}`;
  return new Promise((resolve) => {
    const onAnswer = (event: Event): void => {
      const answer = (event as CustomEvent<FileAnswer>).detail;
      if (answer?.id !== id) return;
      removeEventListener("bunnyhop:native-file", onAnswer);
      resolve(answer);
    };
    addEventListener("bunnyhop:native-file", onAnswer);
    send({ type: "file", id, ...message });
  });
}

/** Shows the open dialog for `purpose`; resolves with the chosen file's text. */
export function openFile(purpose: FilePurpose): Promise<FileAnswer> {
  return request({ action: "open", purpose });
}

/** Shows the save dialog and writes `text` to the chosen file. */
export function saveFile(purpose: "settings", text: string, name: string): Promise<FileAnswer> {
  return request({ action: "save", purpose, text, name });
}

/** The watched stylesheet stops being used (Settings -> Custom CSS -> Stop using). */
export function unwatchCssFile(): void {
  send({ type: "file", action: "unwatch", purpose: "css" });
}
