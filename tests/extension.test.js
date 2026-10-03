import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import commandFrequency from "../index.js";
import { UsageStore } from "../lib/store.js";
import { tempDir } from "./helpers/temp.js";
import { CombinedAutocompleteProvider, editorInputs } from "./helpers/host.js";

function extensionFixture(t) {
  const dir = tempDir(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const events = new Map();
  const commands = new Map();
  const notices = [];
  const confirmations = [];
  const factories = [];
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      confirm: async (...args) => { confirmations.push(args); return false; },
      setEditorComponent: (factory) => factories.push(factory),
    },
  };
  // Only register lifecycle/commands: never construct an agent session or dispatch to a model.
  commandFrequency({
    on: (event, handler) => { assert.equal(events.has(event), false); events.set(event, handler); },
    registerCommand: (name, command) => commands.set(name, command),
  });
  const file = join(dir, "data", "pi-command-frequency", "usage.jsonl");
  const management = commands.get("command-frequency");
  function makeEditor() {
    const { tui, theme, keybindings } = editorInputs();
    const editor = factories.at(-1)(tui, theme, keybindings);
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
      { name: "extension-demo" }, { name: "skill:deploy" }, { name: "command-frequency" },
    ], dir, null));
    const submissions = [];
    editor.onSubmit = (text) => submissions.push(text);
    return { editor, submissions };
  }
  return { dir, file, events, commands, management, ctx, notices, confirmations, factories, makeEditor };
}

test("factory registers commands/events without creating usage data; non-TUI modes install no editor", (t) => {
  const { file, events, commands, ctx, factories } = extensionFixture(t);
  assert.deepEqual([...events.keys()], ["session_start", "session_shutdown"]);
  assert.deepEqual([...commands.keys()], ["command-frequency"]);
  for (const mode of ["rpc", "print", "json"]) events.get("session_start")({}, { ...ctx, mode });
  assert.equal(factories.length, 0);
  assert.equal(existsSync(file), false);
  events.get("session_start")({}, ctx);
  assert.equal(factories.length, 1);
  assert.equal(existsSync(file), false);
});

test("management argument completions filter stats and reset", (t) => {
  const { management } = extensionFixture(t);
  assert.deepEqual(management.getArgumentCompletions(""), [{ value: "stats", label: "stats" }, { value: "reset", label: "reset" }]);
  assert.deepEqual(management.getArgumentCompletions("re"), [{ value: "reset", label: "reset" }]);
  assert.deepEqual(management.getArgumentCompletions("unknown"), []);
});

test("stats reports empty state, default action, invalid action, and hasUI guard", async (t) => {
  const { management, ctx, notices, file } = extensionFixture(t);
  await management.handler("", { ...ctx, hasUI: false });
  assert.deepEqual(notices, []);
  await management.handler("  ", ctx);
  assert.match(notices.at(-1).message, /No command usage recorded/);
  assert.equal(notices.at(-1).level, "info");
  await management.handler("unexpected", ctx);
  assert.deepEqual(notices.at(-1), { message: "Usage: /command-frequency [stats|reset]", level: "warning" });
  assert.equal(existsSync(file), false);
});

test("stats ranks count then recency and limits output to fifteen commands", async (t) => {
  const { management, ctx, notices, file } = extensionFixture(t);
  const store = new UsageStore(file);
  for (let i = 0; i < 18; i++) store.record(`command-${i}`, i);
  store.record("command-0", 0);
  store.record("command-1", 100);
  await management.handler(" stats ", ctx);
  const lines = notices.at(-1).message.split("\n");
  assert.equal(lines.length, 15);
  assert.deepEqual(lines.slice(0, 3), ["/command-1: 2", "/command-0: 2", "/command-17: 1"]);
  assert.equal(notices.at(-1).level, "info");
});

test("reset requires confirmation, preserves counts on cancel, and durably resets on confirm", async (t) => {
  const { management, ctx, notices, confirmations, file } = extensionFixture(t);
  const store = new UsageStore(file);
  store.record("extension-demo", 1);
  await management.handler("reset", ctx);
  assert.equal(store.snapshot().get("extension-demo").count, 1);
  assert.deepEqual(notices, []);
  assert.equal(confirmations.length, 1);
  ctx.ui.confirm = async () => true;
  await management.handler(" reset ", ctx);
  assert.equal(store.snapshot().size, 0);
  assert.deepEqual(notices.at(-1), { message: "Command frequency reset.", level: "info" });
});

test("stats and shutdown flush actual editors, including rebuilt editors and reassigned callbacks", async (t) => {
  const { events, ctx, makeEditor, notices, management, file } = extensionFixture(t);
  events.get("session_start")({}, ctx);
  const first = makeEditor();
  first.editor.setText("/extension-demo private args");
  first.editor.handleInput("\r");
  // The management command must flush the deferred validation itself.
  await management.handler("stats", ctx);
  assert.deepEqual(notices.at(-1), { message: "/extension-demo: 1", level: "info" });
  const rebuilt = makeEditor();
  rebuilt.editor.onSubmit = (text) => rebuilt.submissions.push(`reassigned:${text}`);
  rebuilt.editor.setText("/skill:deploy private prompt");
  rebuilt.editor.handleInput("\r");
  first.editor.setText("/extension-demo");
  first.editor.handleInput("\r");
  await events.get("session_shutdown")();
  await events.get("session_shutdown")(); // Idempotent shutdown.
  assert.deepEqual(first.submissions, ["/extension-demo private args", "/extension-demo"]);
  assert.deepEqual(rebuilt.submissions, ["reassigned:/skill:deploy private prompt"]);
  const snapshot = new UsageStore(file).snapshot();
  assert.equal(snapshot.get("extension-demo").count, 2);
  assert.equal(snapshot.get("skill:deploy").count, 1);
  assert.equal(snapshot.has("command-frequency"), false);
});

test("extension warning is one-shot and failed reset never reports success", async (t) => {
  const { dir, events, ctx, makeEditor, notices, management } = extensionFixture(t);
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data", "pi-command-frequency"), "blocked directory");
  events.get("session_start")({}, ctx);
  const { editor, submissions } = makeEditor();
  for (let i = 0; i < 2; i++) {
    editor.setText("/extension-demo");
    editor.handleInput("\r");
  }
  await editor.flushTracking();
  assert.deepEqual(submissions, ["/extension-demo", "/extension-demo"]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "warning");
  assert.match(notices[0].message, /commands still work normally/);
  ctx.ui.confirm = async () => true;
  await management.handler("reset", ctx);
  assert.equal(notices.length, 1);
  await events.get("session_shutdown")();
});
