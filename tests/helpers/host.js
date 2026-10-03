import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createFrequencyEditor } from "../../lib/editor.js";
import { UsageStore } from "../../lib/store.js";
import { join } from "node:path";
import { tempDir } from "./temp.js";

// Resolve from the installed host, not from a potentially different top-level TUI.
const agentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const hostRequire = createRequire(agentEntry);
export const { CombinedAutocompleteProvider, Editor, KeybindingsManager, TUI_KEYBINDINGS } =
  await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);
export const { BUILTIN_SLASH_COMMANDS } = await import(new URL("./core/slash-commands.js", agentEntry));
export { CustomEditor };
export const FrequencyEditor = createFrequencyEditor(CustomEditor);

const plain = (text) => text;
// EditorTheme is an interface, not a runtime constructor/export.
export const editorTheme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};
export function editorInputs() {
  return {
    tui: { terminal: { rows: 24, columns: 100 }, requestRender() {} },
    theme: editorTheme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
  };
}

export function editorFixture(t, commands = BUILTIN_SLASH_COMMANDS) {
  let editor;
  // Cancel host autocomplete and flush tracking before the temp directory is removed.
  t.after(async () => {
    if (!editor) return;
    editor.handleInput("\x1b");
    editor.setText("");
    await editor.flushTracking();
  });
  const dir = tempDir(t);
  const file = join(dir, "usage.jsonl");
  const store = new UsageStore(file);
  const { tui, theme, keybindings } = editorInputs();
  editor = new FrequencyEditor(tui, theme, keybindings, store);
  const provider = new CombinedAutocompleteProvider(commands, dir, null);
  editor.setAutocompleteProvider(provider);
  const submissions = [];
  editor.onSubmit = (text) => submissions.push(text);
  return { editor, provider, store, file, dir, submissions };
}

export async function submit(editor, text, key = "\r") {
  editor.setText(text);
  editor.handleInput(key);
  await editor.flushTracking();
}

export async function waitForAutocomplete(editor) {
  // Public UI state, with a bounded timeout; do not depend on private request fields.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (editor.isShowingAutocomplete()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertAutocompleteTimeout();
}

function assertAutocompleteTimeout() { throw new Error("Real editor did not show autocomplete within 500 ms"); }
