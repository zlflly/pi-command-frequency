# pi-command-frequency

Lightweight, local-only usage ranking for [Pi](https://pi.dev/) slash-command autocomplete. Type `/` to see commands you actually use first. Search with `/keyword` to rank matching commands by frequency.

**No LLM calls. No telemetry. No runtime dependencies. No SQLite.**

## Install

From a local checkout:

```sh
pi install /absolute/path/to/pi-command-frequency
```

From GitHub (after the repository is published):

```sh
pi install git:github.com/zlflly/pi-command-frequency
```

From npm (after the package is published):

```sh
pi install npm:pi-command-frequency
```

Run `/reload` or restart Pi after installing. Tested with Pi 1.0.0 and Node 26; Node 22.19+ is the package baseline.

## Behavior

- On `/`: most-used commands first; ties prefer recently used commands, then Pi's original order.
- On `/keyword`: exact matches first, then prefix matches, then other fuzzy matches. Within each tier, usage frequency and recency determine order. Skills also match their bare name.
- Only commands submitted through the interactive main editor are counted. Selecting a completion without submitting it does **not** count.
- Built-ins, extension commands, prompt templates, and `/skill:name` commands use the host's actual completion list. No hard-coded built-in list.
- Command argument completions, file/path completions, completion insertion, cancellation signals, and application keybindings are delegated unchanged to Pi.
- Counts are shared across projects and survive restarts and `/reload`. Local concurrent Pi instances append records instead of overwriting each other's totals.
- Invalid commands and normal prompts do not count. A submitted command counts even if its action is subsequently cancelled or fails; this measures invocation frequency, not successful actions. Validation is cancelled after one second if the host provider does not respond, so slow/broken completion providers cannot block shutdown.

Management:

```text
/command-frequency         # show the top 15 counts
/command-frequency stats
/command-frequency reset  # asks for confirmation
```

The management command does not count itself.

## Privacy and storage

Only the command name and submission timestamp are recorded — **never arguments, prompt text, credentials, file contents, or conversation history**.

Default path:

```text
~/.pi/agent/data/pi-command-frequency/usage.jsonl
```

Respects `PI_CODING_AGENT_DIR`. The directory/file are created with modes `0700`/`0600` (existing permissions are not changed). This append-only log is designed for a local filesystem, not a distributed/network share. Partial/corrupt records are skipped. `/command-frequency reset` appends a reset marker; it does **not** physically erase old records. To erase historical names/timestamps, close all Pi instances and delete the file.

The journal is not automatically compacted, to avoid cross-process compaction races; storage grows by roughly 50–200 bytes per invocation. Suggestions cache the parsed totals and only reread the file when it changes. Storage failures warn once and never block command dispatch.

## Compatibility

This extension installs a `CustomEditor` subclass through Pi's public `setEditorComponent` API. It wraps the autocomplete provider Pi supplies rather than recreating it. Another extension that replaces the main editor (for example, a Vim editor or ghost-text editor) can override this one: **only one custom editor is active at a time**. Do not assume editor-replacement extensions compose.

It is active only in terminal UI mode (`ctx.mode === "tui"`), not print/JSON/RPC sessions. It does not retroactively mine old session transcripts or record CLI prompts/programmatically sent commands. New counts start with your first interactive submissions after installing.

## Development

```sh
npm install --ignore-scripts
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

The Pi package in `devDependencies` is only for tests; the published package has no runtime dependencies and gets Pi from its host. Tests cover ranking, delegated completions, submission tracking, persistence, corruption recovery, and concurrent local writers without making model calls.

`npm audit --omit=dev` is clean. The pinned Pi 1.0.0 test host bundles a development-only `brace-expansion` dependency with known DoS advisories that `npm audit fix` does not replace. That host dependency is excluded from this extension's npm tarball. Do not treat the full development dependency tree as audit-clean.

## Publishing

The `pi-package` npm keyword makes the package eligible for [pi.dev/packages](https://pi.dev/packages) discovery. A GitHub repository alone is a supported install source but is not documented as a gallery submission method.

First publish (requires your npm account and authentication):

```sh
npm login --auth-type=web
npm publish --access public
```

Workflow templates are in `examples/workflows/`. They are intentionally **not active**: the current GitHub CLI OAuth authorization has no `workflow` scope. To enable CI/releases, authorize workflow changes (`gh auth refresh -h github.com -s workflow`) or use GitHub's web UI, then copy the templates into `.github/workflows/` and commit them.

For subsequent versions, configure npm Trusted Publishing for GitHub user `zlflly`, repository `pi-command-frequency`, workflow filename `publish.yml`, and allow npm publish. Then bump `package.json`/`package-lock.json`, push a matching `vX.Y.Z` tag, and use the enabled release workflow. GitHub login alone cannot bootstrap npm package ownership.

## License

MIT. See [LICENSE](LICENSE).

[简体中文](README.zh-CN.md)
