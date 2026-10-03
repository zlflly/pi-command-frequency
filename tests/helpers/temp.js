import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-command-frequency-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
