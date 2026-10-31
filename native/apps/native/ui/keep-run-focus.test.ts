import { test, expect } from "bun:test";
import { releaseKeepRunField } from "./keep-run-focus";

function documentWith(insideKeepRun: boolean): { doc: Document; blurred: () => number } {
  let blurs = 0;
  const active = {
    closest: (selector: string) => (selector === ".keep-run" && insideKeepRun ? {} : null),
    blur: () => {
      blurs++;
    },
  };
  return { doc: { activeElement: active } as unknown as Document, blurred: () => blurs };
}

test("resuming takes the focus out of the Keep this run field and leaves other fields alone", () => {
  const field = documentWith(true);
  releaseKeepRunField(field.doc);
  expect(field.blurred()).toBe(1);
  const other = documentWith(false);
  releaseKeepRunField(other.doc);
  expect(other.blurred()).toBe(0);
  releaseKeepRunField({ activeElement: null } as unknown as Document);
});
