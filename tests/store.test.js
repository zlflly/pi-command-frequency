import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { UsageStore } from "../lib/store.js";
import { tempDir } from "./helpers/temp.js";

test("missing store is empty, counts accumulate, and lastUsed never goes backwards", (t) => {
  const file = join(tempDir(t), "nested", "usage.jsonl");
  const store = new UsageStore(file, () => assert.fail("missing file should not warn"));
  assert.deepEqual([...store.snapshot()], []);
  assert.equal(store.record("help", 20), true);
  assert.equal(store.record("help", 10), true);
  assert.equal(store.record("skill:deploy", 0), true);
  assert.deepEqual([...store.snapshot()], [["help", { count: 2, lastUsed: 20 }], ["skill:deploy", { count: 1, lastUsed: 0 }]]);
  assert.deepEqual([...new UsageStore(file).snapshot()], [...store.snapshot()]);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
  }
});

test("reset is durable and subsequent records start fresh", (t) => {
  const file = join(tempDir(t), "usage.jsonl");
  const store = new UsageStore(file);
  store.record("help", 100);
  assert.equal(store.reset(), true);
  assert.deepEqual([...store.snapshot()], []);
  store.record("help", 1);
  assert.deepEqual([...new UsageStore(file).snapshot()], [["help", { count: 1, lastUsed: 1 }]]);
  assert.equal(store.reset(), true);
  assert.equal(store.reset(), true);
  assert.equal(store.snapshot().size, 0);
});

test("record without an explicit timestamp uses the current time", (t) => {
  const store = new UsageStore(join(tempDir(t), "usage.jsonl"));
  const before = Date.now();
  assert.equal(store.record("help"), true);
  const after = Date.now();
  const usage = store.snapshot().get("help");
  assert.equal(usage.count, 1);
  assert.ok(usage.lastUsed >= before && usage.lastUsed <= after);
});

test("invalid records are rejected and persistence contains names/timestamps, never arguments", (t) => {
  const file = join(tempDir(t), "usage.jsonl");
  const store = new UsageStore(file);
  assert.equal(store.record(), false);
  for (const name of ["help secret prompt", "/help", "a/b", "", null, undefined, "a".repeat(129)]) assert.equal(store.record(name, 1), false);
  for (const time of [-1, 1.5, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) assert.equal(store.record("help", time), false);
  assert.equal(store.snapshot().size, 0);
  assert.equal(store.record("help", 5, "TOP-SECRET-PROMPT"), true);
  const raw = readFileSync(file, "utf8");
  assert.equal(raw.includes("TOP-SECRET-PROMPT"), false);
  assert.deepEqual(raw.trim().split("\n").map(JSON.parse), [{ name: "help", time: 5 }]);
});

test("corrupt, oversized, malformed entries are ignored, and partial final writes are isolated", (t) => {
  const file = join(tempDir(t), "usage.jsonl");
  const lines = [
    "not json", "null", "42", "[]", "{}",
    JSON.stringify({ name: "help", time: 2 }),
    JSON.stringify({ name: "bad/command", time: 1 }),
    ...[-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((time) => JSON.stringify({ name: "help", time })),
    JSON.stringify({ name: "help", time: 99, padding: "x".repeat(1100) }),
    JSON.stringify({ name: "help", time: 3 }),
    '{"name":"unfinished"',
  ];
  writeFileSync(file, lines.join("\n"));
  const store = new UsageStore(file, () => assert.fail("bad records should not cause an I/O warning"));
  assert.deepEqual([...store.snapshot()], [["help", { count: 2, lastUsed: 3 }]]);
  assert.equal(store.record("new", 4), true);
  assert.deepEqual([...store.snapshot()], [["help", { count: 2, lastUsed: 3 }], ["new", { count: 1, lastUsed: 4 }]]);
});

test("a reset inside the journal clears only preceding records", (t) => {
  const file = join(tempDir(t), "usage.jsonl");
  writeFileSync(file, [{ name: "old", time: 99 }, { reset: true }, { name: "new", time: 1 }].map(JSON.stringify).join("\n"));
  assert.deepEqual([...new UsageStore(file).snapshot()], [["new", { count: 1, lastUsed: 1 }]]);
});

test("two instances observe each other's writes and resets, including file deletion/recreation", (t) => {
  const file = join(tempDir(t), "usage.jsonl");
  const a = new UsageStore(file);
  const b = new UsageStore(file);
  a.record("help", 1);
  assert.equal(b.snapshot().get("help").count, 1);
  b.record("help", 2);
  assert.equal(a.snapshot().get("help").count, 2);
  a.reset();
  assert.equal(b.snapshot().size, 0);
  b.record("new", 3);
  assert.deepEqual([...a.snapshot()], [["new", { count: 1, lastUsed: 3 }]]);
  unlinkSync(file);
  assert.equal(a.snapshot().size, 0);
  b.record("reborn", 4);
  assert.deepEqual([...a.snapshot()], [["reborn", { count: 1, lastUsed: 4 }]]);
});

test("read/write/reset I/O errors fail open and warn only once per store", (t) => {
  const dir = tempDir(t);
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "blocker");
  const warnings = [];
  const store = new UsageStore(join(blocker, "usage.jsonl"), (error) => warnings.push(error));
  assert.doesNotThrow(() => store.snapshot());
  assert.equal(store.snapshot().size, 0);
  assert.equal(store.record("help", 1), false);
  assert.equal(store.reset(), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "ENOTDIR");
  const file = join(dir, "usage.jsonl");
  const cachedWarnings = [];
  const cached = new UsageStore(file, (error) => cachedWarnings.push(error));
  cached.record("help", 1);
  cached.snapshot();
  unlinkSync(file);
  mkdirSync(file);
  assert.deepEqual([...cached.snapshot()], [["help", { count: 1, lastUsed: 1 }]]);
  assert.equal(cached.record("help", 2), false);
  assert.equal(cached.reset(), false);
  assert.equal(cachedWarnings.length, 1);
  assert.equal(cachedWarnings[0].code, "EISDIR");
});

test("concurrent subprocess writers never lose records", { timeout: 20000 }, async (t) => {
  let workers = [];
  t.after(async () => {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
  });
  const file = join(tempDir(t), "shared", "usage.jsonl");
  const repetitions = 250;
  workers = Array.from({ length: 4 }, (_, id) => {
    const child = fork(new URL("./fixtures/store-writer.mjs", import.meta.url), [file, String(id), String(repetitions)],
      { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`writer ${id}: ${code}/${signal}: ${stderr}`)));
    });
    // Attach immediately so an early worker failure cannot become an unhandled rejection.
    done.catch(() => {});
    const ready = new Promise((resolve, reject) => {
      child.once("message", (message) => message === "ready" ? resolve() : reject(new Error(`Unexpected message: ${message}`)));
      done.then(() => reject(new Error("worker exited before ready")), reject);
    });
    return { child, ready, done };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  workers.forEach(({ child }) => child.send("go"));
  await Promise.all(workers.map((worker) => worker.done));
  const usage = new UsageStore(file).snapshot();
  assert.equal(usage.size, 5);
  assert.deepEqual(usage.get("shared"), { count: 4 * repetitions, lastUsed: repetitions - 1 });
  for (let id = 0; id < 4; id++) assert.deepEqual(usage.get(`writer-${id}`), { count: repetitions, lastUsed: repetitions - 1 });
  const records = readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(records.length, 8 * repetitions);
});
