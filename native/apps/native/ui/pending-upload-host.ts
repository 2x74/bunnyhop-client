// The host's store of runs waiting to upload (pending_uploads.hpp), for run-service.ts.
import { send } from "./bridge";
import { parsePendingUpload, plainObject, type PendingUpload, type PendingUploadStore } from "./pending-uploads";

const STORE_ANSWER_MS = 10_000;

let nextRequest = 0;

/** The host's list of records, or with an id that replay's bytes; null if it fails or doesn't answer in time. */
function ask(replayId?: string): Promise<Record<string, unknown> | null> {
  const request = `upload-${++nextRequest}`;
  return new Promise((resolve) => {
    const finish = (answer: Record<string, unknown> | null) => {
      clearTimeout(timer);
      removeEventListener("bunnyhop:native-upload-store", onAnswer);
      resolve(answer && !answer.error ? answer : null);
    };
    const onAnswer = (event: Event) => {
      const answer = plainObject((event as CustomEvent<unknown>).detail);
      if (answer?.request === request) finish(answer);
    };
    const timer = setTimeout(() => finish(null), STORE_ANSWER_MS);
    addEventListener("bunnyhop:native-upload-store", onAnswer);
    if (replayId === undefined) send({ type: "pendingUpload", action: "list", request });
    else send({ type: "pendingUpload", action: "replay", id: replayId, request });
  });
}

/** The host's store (pending_uploads.hpp). */
export const nativeUploadStore: PendingUploadStore = {
  async list() {
    const answer = await ask();
    const records = Array.isArray(answer?.records) ? answer.records : [];
    const uploads: PendingUpload[] = [];
    for (const entry of records) {
      const found = plainObject(entry);
      const upload = found && typeof found.id === "string" ? parsePendingUpload(found.id, found.record) : null;
      if (upload) uploads.push(upload);
    }
    return uploads;
  },
  async save(upload) {
    send({ type: "pendingUpload", action: "save", id: upload.id, record: upload });
  },
  async remove(id) {
    send({ type: "pendingUpload", action: "remove", id });
  },
  async replay(id) {
    const answer = await ask(id);
    return typeof answer?.replayBase64 === "string" ? answer.replayBase64 : null;
  },
};
