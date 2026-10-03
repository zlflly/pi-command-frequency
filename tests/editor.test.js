import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wrapProvider } from "../lib/ranking.js";
import { UsageStore } from "../lib/store.js";
import { CustomEditor, Editor, CombinedAutocompleteProvider, BUILTIN_SLASH_COMMANDS,
  editorFixture, submit, waitForAutocomplete } from "./helpers/host.js";

test("real CustomEditor and its own TUI count each host builtin once on Enter", async (t) => {
  const { editor, provider, store, submissions } = editorFixture(t);
  assert.ok(editor instanceof CustomEditor);
  assert.ok(editor instanceof Editor);
  assert.ok(provider instanceof CombinedAutocompleteProvider);
  for (const { name } of BUILTIN_SLASH_COMMANDS) await submit(editor, `/${name}`);
  assert.equal(submissions.length, BUILTIN_SLASH_COMMANDS.length);
  assert.equal(store.snapshot().size, BUILTIN_SLASH_COMMANDS.length);
  for (const { name } of BUILTIN_SLASH_COMMANDS) {
    assert.equal(store.snapshot().get(name)?.count, 1, name);
    assert.ok(Number.isSafeInteger(store.snapshot().get(name).lastUsed));
  }
  await submit(editor, "/model secret-provider/private-model");
  assert.equal(store.snapshot().get("model").count, 2);
});

test("extension and skill submissions count once, without persisting arguments or prompts", async (t) => {
  const { editor, store, file, submissions } = editorFixture(t, [
    { name: "extension-demo", description: "An extension command" },
    { name: "skill:deploy", description: "A skill command" },
    { value: "template-demo", label: "A template command" },
  ]);
  for (const text of ["/extension-demo TOP-SECRET-ARG", "/skill:deploy PRIVATE-PROMPT", "/template-demo PRIVATE-TEMPLATE"]) {
    await submit(editor, text);
  }
  assert.deepEqual(submissions, ["/extension-demo TOP-SECRET-ARG", "/skill:deploy PRIVATE-PROMPT", "/template-demo PRIVATE-TEMPLATE"]);
  assert.deepEqual([...store.snapshot()].map(([name, usage]) => [name, usage.count]),
    [["extension-demo", 1], ["skill:deploy", 1], ["template-demo", 1]]);
  for (const record of readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse)) {
    assert.deepEqual(Object.keys(record).sort(), ["name", "time"]);
  }
  assert.doesNotMatch(readFileSync(file, "utf8"), /SECRET|PRIVATE/);
});

test("Tab completion and menu navigation do not count; subsequent Enter counts exactly once", async (t) => {
  const { editor, store, submissions } = editorFixture(t, [{ name: "extension-demo" }, { name: "extension-other" }]);
  editor.setText("/extension-");
  editor.handleInput("\t");
  await waitForAutocomplete(editor);
  editor.render(100); // Exercise the real SelectList with a valid no-color EditorTheme.
  editor.handleInput("\x1b[B");
  editor.handleInput("\x1b[A");
  editor.handleInput("\t");
  await editor.flushTracking();
  assert.deepEqual(submissions, []);
  assert.equal(store.snapshot().size, 0);
  assert.match(editor.getText(), /^\/extension-(demo|other) $/);
  const completedName = editor.getText().trim().slice(1);
  editor.handleInput("\r");
  await editor.flushTracking();
  assert.deepEqual(submissions, [`/${completedName}`]);
  assert.equal(store.snapshot().get(completedName)?.count, 1);
});

test("Enter accepting a command menu dispatches and counts only once", async (t) => {
  const { editor, store, submissions } = editorFixture(t, [{ name: "extension-demo" }, { name: "extension-other" }]);
  editor.setText("/extension-");
  editor.handleInput("\t");
  await waitForAutocomplete(editor);
  editor.handleInput("\r");
  await editor.flushTracking();
  assert.equal(submissions.length, 1);
  assert.match(submissions[0], /^\/extension-(demo|other)$/);
  assert.equal(store.snapshot().get(submissions[0].slice(1))?.count, 1);
  assert.equal(store.snapshot().size, 1);
});

test("the real command menu learns submissions and immediately sees reset/external writes", async (t) => {
  const { editor, store, file } = editorFixture(t, [{ name: "alpha" }, { name: "zebra" }]);
  await submit(editor, "/zebra");
  async function tabSelectedCommand() {
    editor.setText("/");
    editor.handleInput("\t");
    await waitForAutocomplete(editor);
    editor.handleInput("\t");
    await editor.flushTracking();
    return editor.getText();
  }
  assert.equal(await tabSelectedCommand(), "/zebra ");
  assert.equal(store.snapshot().get("zebra").count, 1, "Tab must not change learned counts");
  store.reset();
  assert.equal(await tabSelectedCommand(), "/alpha ");
  assert.equal(store.snapshot().size, 0);
  new UsageStore(file).record("zebra", 1);
  assert.equal(await tabSelectedCommand(), "/zebra ");
  assert.equal(store.snapshot().get("zebra").count, 1);
});

test("bare skill query completes to the canonical command and records only submission", async (t) => {
  const { editor, store, submissions } = editorFixture(t, [{ name: "skill:deploy" }, { name: "skill:deploy-long" }]);
  editor.setText("/deploy");
  editor.handleInput("\t");
  await waitForAutocomplete(editor);
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/skill:deploy ");
  assert.equal(store.snapshot().size, 0);
  editor.handleInput("\r");
  await editor.flushTracking();
  assert.deepEqual(submissions, ["/skill:deploy"]);
  assert.equal(store.snapshot().get("skill:deploy")?.count, 1);
});

test("noncommands, unknown/fuzzy-only matches, multiline input, and management commands are not counted", async (t) => {
  const { editor, store, submissions } = editorFixture(t, [...BUILTIN_SLASH_COMMANDS, { name: "skill:deploy" }, { name: "command-frequency" }]);
  const texts = ["ordinary prompt", "mention /model", "!echo hello", "//model", "/tmp/file", "/not-a-command", "/mod", "/deploy",
    "/model\nprivate prompt", "/command-frequency stats", "/command-frequency reset", ""];
  for (const text of texts) await submit(editor, text);
  assert.deepEqual(submissions, texts);
  assert.equal(store.snapshot().size, 0);
});

test("Shift+Enter/newline, disabled submit, and absent onSubmit never record a command", async (t) => {
  const { editor, store, submissions } = editorFixture(t);
  editor.setText("/model");
  editor.handleInput("\n");
  await editor.flushTracking();
  assert.deepEqual(submissions, []);
  assert.equal(store.snapshot().size, 0);
  editor.disableSubmit = true;
  await submit(editor, "/model");
  assert.deepEqual(submissions, []);
  assert.equal(store.snapshot().size, 0);
  editor.disableSubmit = false;
  editor.onSubmit = undefined;
  await submit(editor, "/model");
  assert.equal(store.snapshot().size, 0);
});

test("onSubmit reassignment keeps dispatch immediate and tracking exactly once", async (t) => {
  const { editor, store } = editorFixture(t);
  const first = [];
  const second = [];
  editor.onSubmit = (text) => first.push(text);
  editor.setText("/model");
  editor.handleInput("\r");
  assert.deepEqual(first, ["/model"], "tracking must not delay dispatch");
  editor.onSubmit = (text) => second.push(text);
  editor.setText("/model second");
  editor.handleInput("\r");
  assert.deepEqual(second, ["/model second"]);
  await editor.flushTracking();
  assert.equal(store.snapshot().get("model")?.count, 2);
});

test("provider replacement uses the current command list and unwraps existing frequency wrappers", async (t) => {
  const { editor, store, dir, submissions } = editorFixture(t, [{ name: "old-command" }]);
  await submit(editor, "/old-command");
  const replacement = new CombinedAutocompleteProvider([{ name: "new-command" }], dir, null);
  let wrappedUsageReads = 0;
  editor.setAutocompleteProvider(wrapProvider(replacement, () => { wrappedUsageReads++; return new Map(); }));
  await submit(editor, "/old-command");
  await submit(editor, "/new-command");
  assert.deepEqual(submissions, ["/old-command", "/old-command", "/new-command"]);
  assert.deepEqual([...store.snapshot()].map(([name, usage]) => [name, usage.count]), [["old-command", 1], ["new-command", 1]]);
  assert.equal(wrappedUsageReads, 0, "the old frequency wrapper must not be stacked");
});

test("pending validation belongs to the provider present at submission, even after replacement", async (t) => {
  const { editor, store, dir } = editorFixture(t, [{ name: "old-command" }]);
  editor.setText("/old-command");
  editor.handleInput("\r");
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "new-command" }], dir, null));
  editor.setText("/new-command");
  editor.handleInput("\r");
  await editor.flushTracking();
  assert.equal(store.snapshot().get("old-command")?.count, 1);
  assert.equal(store.snapshot().get("new-command")?.count, 1);
});

test("provider rejection and store I/O failure do not break actual Enter dispatch", async (t) => {
  const { editor, provider, dir, submissions } = editorFixture(t, [{ name: "extension-demo" }]);
  const original = provider.getSuggestions;
  provider.getSuggestions = async () => { throw new Error("provider failed"); };
  await submit(editor, "/extension-demo");
  provider.getSuggestions = original;
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  let warnings = 0;
  editor.store = new UsageStore(join(blocker, "usage.jsonl"), () => { warnings++; });
  await submit(editor, "/extension-demo");
  await submit(editor, "/extension-demo");
  assert.deepEqual(submissions, Array(3).fill("/extension-demo"));
  assert.equal(editor.store.snapshot().size, 0);
  assert.equal(warnings, 1);
});

test("real combined provider's argument and file completion results stay unchanged by wrapping", async (t) => {
  const { provider, store, dir } = editorFixture(t, [{ name: "choose", getArgumentCompletions: () => [
    { value: "alpha", label: "Alpha" }, { value: "beta", label: "Beta" },
  ] }]);
  writeFileSync(join(dir, "alpha.txt"), "alpha");
  writeFileSync(join(dir, "beta.txt"), "beta");
  store.record("beta", 1);
  const wrapped = wrapProvider(provider, () => store.snapshot());
  for (const [text, extra] of [["/choose ", {}], ["./", {}], ["./", { force: true }]]) {
    const options = { signal: new AbortController().signal, ...extra };
    const baseline = await provider.getSuggestions([text], 0, text.length, options);
    assert.ok(baseline?.items.length, text);
    const result = await wrapped.getSuggestions([text], 0, text.length, options);
    assert.deepEqual(result, baseline);
    assert.deepEqual(wrapped.applyCompletion([text], 0, text.length, result.items[0], result.prefix),
      provider.applyCompletion([text], 0, text.length, baseline.items[0], baseline.prefix));
  }
});
