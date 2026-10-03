import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { validName } from "./ranking.js";

// Append-only records avoid read/modify/write races across local Pi processes.
// No arguments/prompts, SQLite, dependencies, timers, or network requests.
export class UsageStore {
  constructor(file, onError = () => {}) {
    this.file = file;
    this.onError = onError;
    this.signature = undefined;
    this.usage = new Map();
    this.reportedError = false;
  }

  report(error) {
    if (!this.reportedError) {
      this.reportedError = true;
      this.onError(error);
    }
  }

  snapshot() {
    try {
      const stat = statSync(this.file);
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (signature === this.signature) return this.usage;
      const usage = new Map();
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line || line.length > 1024) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.reset === true) { usage.clear(); continue; }
        if (!validName(event?.name) || !Number.isSafeInteger(event.time) || event.time < 0) continue;
        const previous = usage.get(event.name);
        usage.set(event.name, {
          count: (previous?.count ?? 0) + 1,
          lastUsed: Math.max(previous?.lastUsed ?? 0, event.time),
        });
      }
      this.usage = usage;
      this.signature = signature;
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.usage = new Map();
        this.signature = undefined;
      } else this.report(error);
    }
    return this.usage;
  }

  append(event) {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      // Leading newline also isolates an incomplete final record after a crash.
      appendFileSync(this.file, `\n${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      this.signature = undefined;
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  record(name, time = Date.now()) {
    if (!validName(name) || !Number.isSafeInteger(time) || time < 0) return false;
    return this.append({ name, time });
  }

  reset() { return this.append({ reset: true }); }
}
