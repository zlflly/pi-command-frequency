import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createFrequencyEditor } from "./lib/editor.js";
import { UsageStore } from "./lib/store.js";

const FrequencyEditor = createFrequencyEditor(CustomEditor);

export default function commandFrequency(pi) {
  const configuredDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configuredDir
    ? configuredDir === "~" ? homedir()
      : configuredDir.startsWith("~/") ? join(homedir(), configuredDir.slice(2))
        : isAbsolute(configuredDir) ? configuredDir : resolve(configuredDir)
    : join(homedir(), ".pi", "agent");
  const file = join(agentDir, "data", "pi-command-frequency", "usage.jsonl");
  let warn = () => {};
  const store = new UsageStore(file, () => warn());
  const editors = new Set();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    warn = () => ctx.ui.notify("Command frequency: local usage data could not be read/written; commands still work normally.", "warning");
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // Pi may rebuild the editor on reload/theme/session changes.
      const editor = new FrequencyEditor(tui, theme, keybindings, store);
      editors.add(editor);
      return editor;
    });
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...editors].map((editor) => editor.flushTracking()));
    editors.clear();
    warn = () => {};
  });

  pi.registerCommand("command-frequency", {
    description: "Show slash-command usage counts, or reset them",
    getArgumentCompletions: (prefix) => ["stats", "reset"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      await Promise.all([...editors].map((editor) => editor.flushTracking()));
      const action = args.trim() || "stats";
      if (action === "reset") {
        if (await ctx.ui.confirm("Reset command frequency?", "Forget all recorded command counts?")) {
          // Submissions added while stats/confirmation awaited must not publish
          // late records across this process's reset boundary.
          for (const editor of editors) editor.cancelTracking();
          if (store.reset()) ctx.ui.notify("Command frequency reset.", "info");
        }
        return;
      }
      if (action !== "stats") {
        ctx.ui.notify("Usage: /command-frequency [stats|reset]", "warning");
        return;
      }
      const entries = [...store.snapshot()].sort((a, b) => b[1].count - a[1].count || b[1].lastUsed - a[1].lastUsed);
      ctx.ui.notify(entries.length
        ? entries.slice(0, 15).map(([name, usage]) => `/${name}: ${usage.count}`).join("\n")
        : "No command usage recorded yet. Submit a slash command to start learning.", "info");
    },
  });
}
