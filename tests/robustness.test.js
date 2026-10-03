import test from "node:test";
import assert from "node:assert/strict";
import { wrapProvider } from "../lib/ranking.js";
import { editorFixture } from "./helpers/host.js";

const tick = () => new Promise((done) => setImmediate(done));

test("a frozen provider can be wrapped without violating Proxy invariants", async () => {
  const provider = Object.freeze({
    marker: 42,
    getSuggestions() {
      assert.equal(this.marker, 42);
      return { prefix: "/", items: [{ value: "alpha" }, { value: "zebra" }] };
    },
    applyCompletion() { return this.marker; },
  });
  const wrapped = wrapProvider(provider, () => new Map([["zebra", { count: 3, lastUsed: 1 }]]));
  const result = await wrapped.getSuggestions(["/"], 0, 1, {});
  assert.deepEqual(result.items.map((item) => item.value), ["zebra", "alpha"]);
  assert.equal(wrapped.applyCompletion(), 42);
  assert.deepEqual(Object.keys(wrapped), Object.keys(provider));
});

test("hung validation is bounded, aborts, and cannot write a late record", async (t) => {
  const { editor, store, submissions } = editorFixture(t);
  editor.trackingTimeoutMs = 15;
  let resolve;
  let signal;
  editor.setAutocompleteProvider({ getSuggestions(_lines, _row, _col, options) {
    signal = options.signal;
    return new Promise((done) => { resolve = done; });
  } });
  editor.onSubmit("/model");
  assert.deepEqual(submissions, ["/model"]);
  await editor.flushTracking();
  assert.equal(signal.aborted, true);
  assert.equal(editor.pendingRecords.size, 0);
  resolve({ prefix: "/model", items: [{ value: "model" }] });
  await tick();
  assert.equal(store.snapshot().size, 0);
});

test("reset cancellation invalidates submissions added during an earlier flush", async (t) => {
  const { editor, store } = editorFixture(t);
  const requests = [];
  editor.setAutocompleteProvider({ getSuggestions(lines) {
    return new Promise((done) => requests.push(() => done({ prefix: lines[0], items: [{ value: "model" }] })));
  } });
  editor.onSubmit("/model");
  const earlierFlush = editor.flushTracking();
  await tick();
  editor.onSubmit("/model newer");
  await tick();
  requests[0]();
  await earlierFlush;
  assert.equal(store.snapshot().get("model").count, 1);
  editor.cancelTracking();
  store.reset();
  await editor.flushTracking();
  requests[1]();
  await tick();
  assert.equal(store.snapshot().size, 0);
});

test("wrapping a saved onSubmit callback does not recurse or double count", async (t) => {
  const { editor, store, submissions } = editorFixture(t);
  const original = editor.onSubmit;
  editor.onSubmit = (text) => original(text);
  editor.onSubmit("/model");
  await editor.flushTracking();
  assert.deepEqual(submissions, ["/model"]);
  assert.equal(store.snapshot().get("model").count, 1);
});
