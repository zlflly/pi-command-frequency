import test from "node:test";
import assert from "node:assert/strict";
import { commandName, validName, rankItems, wrapProvider, unwrapProvider } from "../lib/ranking.js";

const items = (...names) => names.map((value) => ({ value, label: `/${value}` }));
const values = (result) => result.map((item) => item.value);

test("frequency, recency, then original fuzzy order break ranking ties", () => {
  const input = items("unused-a", "older", "frequent", "newer", "unused-b", "same");
  const usage = new Map([
    ["frequent", { count: 3, lastUsed: 1 }],
    ["older", { count: 2, lastUsed: 10 }],
    ["newer", { count: 2, lastUsed: 20 }],
    ["same", { count: 2, lastUsed: 20 }],
    ["absent", { count: 999, lastUsed: 999 }],
  ]);
  assert.deepEqual(values(rankItems(input, usage)), ["frequent", "newer", "same", "older", "unused-a", "unused-b"]);
  assert.deepEqual(values(rankItems(input, new Map())), values(input));
});

test("exact and prefix matches outrank much more frequent fuzzy matches", () => {
  const usage = new Map([
    ["forest", { count: 1000, lastUsed: 1000 }],
    ["reset", { count: 100, lastUsed: 100 }],
    ["rename", { count: 2, lastUsed: 2 }],
  ]);
  assert.deepEqual(values(rankItems(items("forest", "reset", "re", "rename"), usage, "RE")),
    ["re", "reset", "rename", "forest"]);
});

test("skills match both their full command and bare query", () => {
  const input = items("explore", "skill:deploy-long", "skill:deploy");
  const usage = new Map([["explore", { count: 1000, lastUsed: 1000 }]]);
  assert.deepEqual(values(rankItems(input, usage, "DEPLOY")), ["skill:deploy", "skill:deploy-long", "explore"]);
  assert.deepEqual(values(rankItems(input, usage, "skill:deploy")), ["skill:deploy", "skill:deploy-long", "explore"]);
});

test("ranking never mutates or clones original items, array, or usage", () => {
  const input = Object.freeze(items("a", "b", "c").map((item) => Object.freeze({ ...item, metadata: { preserved: true } })));
  const usage = new Map([["b", Object.freeze({ count: 1, lastUsed: 1 })]]);
  const before = structuredClone(input);
  const ranked = rankItems(input, usage);
  assert.notEqual(ranked, input);
  assert.deepEqual(input, before);
  assert.deepEqual(ranked, [input[1], input[0], input[2]]);
  ranked.forEach((item) => assert.ok(input.includes(item)));
  assert.deepEqual([...usage], [["b", { count: 1, lastUsed: 1 }]]);
});

test("command parsing accepts only single-line slash commands and excludes arguments", () => {
  for (const [text, name] of [["/help", "help"], [" /help private prompt ", "help"],
    ["/skill:deploy\tsecret", "skill:deploy"], ["/日本語-1._:+", "日本語-1._:+"]]) {
    assert.equal(commandName(text), name);
  }
  for (const text of [null, undefined, 1, "", "/", "help", "//help", "/tmp/file", "/help\nsecret", "/help\r", "/bad!", `/${"a".repeat(129)}`]) {
    assert.equal(commandName(text), null, String(text));
  }
  assert.equal(validName("a".repeat(128)), true);
  for (const name of ["", null, 1, "a b", "a/b", "a\n", "a".repeat(129)]) assert.equal(validName(name), false);
});

test("wrapper ranks only command-name suggestions and preserves result metadata and item identity", async () => {
  const original = Object.freeze({ prefix: "/", items: Object.freeze(items("a", "b").map(Object.freeze)), extra: { future: true } });
  let received;
  const provider = { async getSuggestions(...args) { received = args; return original; } };
  const wrapped = wrapProvider(provider, () => new Map([["b", { count: 1, lastUsed: 1 }]]));
  const lines = ["/"];
  const options = { signal: new AbortController().signal, future: true };
  const result = await wrapped.getSuggestions(lines, 0, 1, options);
  assert.equal(received[0], lines);
  assert.equal(received[3], options);
  assert.notEqual(result, original);
  assert.equal(result.extra, original.extra);
  assert.equal(result.items[0], original.items[1]);
  assert.deepEqual(values(original.items), ["a", "b"]);
});

test("wrapper transparently passes files, arguments, force, multiline, mismatched prefixes, and null", async (t) => {
  const cases = [
    ["files", ["@file"], 0, 5, {}, "@file"],
    ["paths", ["/tmp/file"], 0, 9, {}, "/tmp/file"],
    ["arguments", ["/model fast"], 0, 11, {}, "fast"],
    ["force", ["/"], 0, 1, { force: true }, "/"],
    ["second line", ["message", "/"], 1, 1, {}, "/"],
    ["prefix mismatch", ["/"], 0, 1, {}, "other"],
    ["no results", ["/"], 0, 1, {}, null],
  ];
  for (const [name, lines, line, col, extra, prefix] of cases) await t.test(name, async () => {
    const options = { signal: new AbortController().signal, ...extra };
    const result = prefix === null ? null : Object.freeze({ prefix, items: Object.freeze(items("a", "b")) });
    const provider = { async getSuggestions(...args) {
      assert.equal(this, provider);
      assert.equal(args[0], lines);
      assert.deepEqual(args.slice(1, 3), [line, col]);
      assert.equal(args[3], options);
      return result;
    } };
    const wrapped = wrapProvider(provider, () => { assert.fail("usage must not be read for unrelated completions"); });
    assert.equal(await wrapped.getSuggestions(lines, line, col, options), result);
  });
});

test("wrapper preserves original this binding for private-field getters and optional/future methods", async () => {
  class Provider {
    #token = {};
    get triggerCharacters() { return this.#token; }
    async getSuggestions() { return { prefix: "/", items: items("a") }; }
    applyCompletion(...args) { return { token: this.#token, args }; }
    shouldTriggerFileCompletion() { return this.#token; }
    futureMethod() { return this.#token; }
  }
  const provider = new Provider();
  const wrapped = wrapProvider(provider, () => new Map());
  const token = provider.triggerCharacters;
  assert.equal(wrapped.triggerCharacters, token);
  const args = [["/"], 0, 1, items("a")[0], "/"];
  assert.deepEqual(wrapped.applyCompletion(...args), { token, args });
  assert.equal(wrapped.shouldTriggerFileCompletion(), token);
  assert.equal(wrapped.futureMethod(), token);
  assert.equal(unwrapProvider(wrapped), provider);
  assert.equal(unwrapProvider(wrapProvider(wrapped, () => new Map())), provider);
  assert.equal(unwrapProvider(provider), provider);
  assert.equal(unwrapProvider(undefined), undefined);
});

test("wrapper forwards abort signal identity/reason and propagates provider failures", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const provider = { getSuggestions(_lines, _line, _col, options) {
    assert.equal(options.signal, controller.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  } };
  const wrapped = wrapProvider(provider, () => assert.fail("aborted requests must not rank"));
  const request = wrapped.getSuggestions(["/"], 0, 1, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(request, (error) => error === reason);
  const failed = wrapProvider({ getSuggestions() { throw reason; } }, () => new Map());
  await assert.rejects(failed.getSuggestions(["/"], 0, 1), (error) => error === reason);
});
