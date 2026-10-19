# Pie

Pie is a source fork of [Pi](https://github.com/earendil-works/pi), originally created by **Mario Zechner**. It keeps Pi's extensible agent runtime and adds built-in task tracking, isolated subagents, background shell jobs, structured user questions, a usage dashboard, and a single-pane terminal interface with floating panels.

Its product version is independent of upstream SDK package versions. This fork lives at [chocotan/pie](https://github.com/chocotan/pie). Its command is `pie`, its global configuration directory is `~/.pie`, and project configuration lives in `.pie`. The original MIT license and attribution are preserved in [LICENSE](LICENSE).

## What Pie adds

- **Replaceable built-in plugins:** Todo tools, isolated subagents, background shell jobs, `ask_user_question`, Ponytail, usage and catch-all retry load by default. Disable or replace each plugin independently through the extension loader.
- **Single-pane terminal UI:** the conversation uses the terminal width, with a rounded composer and dismissible Todo, Subagents and background-job panels floating at the top right. Empty panels stay hidden, and the panels do not take keyboard focus.
- **Purpose-based tool titles:** coding tools and delegated runs show a short description of their purpose. Expand a row to inspect its full arguments and output.
- **Visible progress:** tool and subagent rows share animated dots, completion states, and elapsed times. Clickable titles, panel entries, and close buttons highlight on hover in fullscreen mode.
- **Subagent conversations:** open a delegated run from its floating panel to inspect instructions, Thinking, tool calls, and answers, then return to the parent conversation.
- **Ponytail built in:** `/ponytail lite|full|ultra|off`, with review, audit, debt, gain and help skills, adapted from [Dietrich Gebert's Ponytail](https://github.com/DietrichGebert/ponytail) under MIT. Disable the plugin with `-builtin:ponytail`.
- **Usage dashboard:** `/usage [day|week|month|total|cal]` shows recorded tokens and costs by provider/model, with period navigation and a calendar. Adapted from [pi-usage](https://github.com/chocotan/pi-usage) under MIT.
- **Background shell jobs:** `bg_run`, `bg_status`, `bg_logs` and `bg_kill` run commands without blocking the conversation, retain bounded logs, and report completion. Jobs appear in the shared floating-panel stack. Adapted from [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) under ISC.
- **Catch-all retry:** the built-in `retry` plugin owns automatic retry, retrying every failed turn except context overflow, continuing truncated responses, and adding `/retry`, `/retry status`, and `/retry reset`. Adapted from [pi-retry](https://github.com/monotykamary/pi-retry) under MIT.
- **Single-line session footer:** folder, branch, usage totals, model and thinking level share one row; narrow windows shorten secondary information.
- **Provider configuration:** use `/login` and `/model` for supported providers, or configure compatible endpoints and local models in `~/.pie/models.json`.

See [Pie features and configuration](packages/coding-agent/docs/pie.md) for plugin settings, task and subagent behavior, structured questions, and terminal details.

## Install and update

Install Pie on Linux or macOS with Node.js 22.19+ and Git:

```bash
curl -fsSL https://raw.githubusercontent.com/chocotan/pie/main/scripts/install.sh | bash
```

Or install from a Git checkout:

```bash
git clone --branch main https://github.com/chocotan/pie.git
cd pie
./scripts/install.sh --local
```

The installer keeps a managed checkout in `~/.pie/source`, versioned runtimes in `~/.pie/runtime`, and the `pie` launcher in `~/.local/bin`. Add that bin directory to your `PATH` if needed. Dependency lifecycle scripts are disabled; compilation runs explicitly. User configuration is not overwritten or imported.

Update the installed application with `pie update`, or:

```bash
curl -fsSL https://raw.githubusercontent.com/chocotan/pie/main/scripts/update.sh | bash
```

Git checkouts can also run `./scripts/update.sh`. New installations track `main`. Updates require a clean managed checkout and fast-forward its recorded branch; existing installations keep their recorded branch, and prior runtimes remain available if a build fails. Use `--bin-dir` or `PIE_INSTALL_BIN_DIR` to choose the launcher directory and `PIE_CODING_AGENT_DIR` to choose a separate installation/configuration root. Windows users can run Pie from source or a local npm consumer as described below; these shell installers target Linux/macOS.

## Run from source

Use Node.js **22.19 or newer**. Clone this fork and check out the branch or revision you intend to use:

```bash
git clone --branch main https://github.com/chocotan/pie.git
cd pie
npm install --ignore-scripts
./pi-test.sh
```

`./pi-test.sh` runs Pie directly from source; a build is not required. The script retains its source filename, but the application and CLI command are named `pie`.

To work in another directory, invoke the script by its absolute path from that directory:

```bash
cd /path/to/project
/path/to/pie/pi-test.sh
```

Inside Pie, run `/login` to connect a supported subscription or API key, then `/model` to choose a model. Give Pie a task in the conversation.

The installers at pi.dev and the published upstream `@earendil-works/pi-coding-agent` npm package install **Pi upstream**. Use this fork's scripts above for Pie; no Pie npm publication is assumed.

## Configuration and providers

Global configuration and runtime data live directly under `~/.pie`, with no `agent` subdirectory:

```text
~/.pie/
  auth.json
  models.json
  settings.json
  keybindings.json
  extensions/
  skills/
  prompts/
  themes/
  agents/
  sessions/
  subagents/
```

Project resources live in `<project>/.pie`. Override the global directory with `PIE_CODING_AGENT_DIR`, or session storage with `PIE_CODING_AGENT_SESSION_DIR`.

When Pie has no model configuration, interactive startup can import Pi's `models.json` after explicit confirmation. Existing Pie files are never overwritten. Other previous Pi and pi-ext data is not loaded or migrated automatically. Pie provides no `pi` or `pi-ext` command alias and no fallback to old directory override variables.

For a supported provider, use `/login` or its API-key environment variable. For an OpenAI-compatible endpoint, for example a local Ollama server, add an entry to `~/.pie/models.json`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

The dummy key is for this local example; use the endpoint's actual authentication when required. Opening `/model` reloads the configuration. Keep credentials private. See [Providers](packages/coding-agent/docs/providers.md), [Models](packages/coding-agent/docs/models.md), and [Custom Providers](packages/coding-agent/docs/custom-provider.md) for supported authentication, model metadata, and extension-based providers.

## Local package installation and SDK use

Internal npm and SDK package names remain `@earendil-works/*`, including `@earendil-works/pi-coding-agent`. The package author remains Mario Zechner. These names identify the libraries; the fork's CLI binary is only `pie`.

To install this checkout into an existing local npm project, build and pack a coherent set of local packages from the repository root:

```bash
npm run pack:packages -- --out .artifacts/pie-packages
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pie-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-coding-agent
cd ../my-project
npm install --ignore-scripts
./node_modules/.bin/pie
```

The consumer directory must already contain a `package.json`. The pack helper builds all public packages and refreshes model data; pass `--offline-model-data` to use already-hydrated model data without refreshing it. The wiring helper updates the consumer's direct dependencies and transitive overrides to use the local artifact set, so internal dependencies come from this checkout too. Keep the artifact directory available and repeat the pack, wiring, and install steps after source changes. This is a local installation, not a registry publication or global install.

For SDK-only use, select packages such as `@earendil-works/pi-agent-core` or `@earendil-works/pi-durable` instead. Repeat `--package` for multiple direct dependencies. pnpm consumers can add `--package-manager pnpm`, point `--consumer` at their workspace root, and run `pnpm install --ignore-scripts` there.

## Documentation and extension APIs

Pie retains Pi's extension, provider, and SDK APIs:

- [Documentation index](packages/coding-agent/docs/index.md) and [interactive usage](packages/coding-agent/docs/usage.md)
- [Extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), [themes](packages/coding-agent/docs/themes.md), and [packages](packages/coding-agent/docs/packages.md)
- [CLI and print mode](packages/coding-agent/docs/cli.md), [JSON events](packages/coding-agent/docs/json.md), and [RPC](packages/coding-agent/docs/rpc.md)
- [TypeScript SDK](packages/coding-agent/docs/sdk.md) and [custom providers](packages/coding-agent/docs/custom-provider.md)

Much of the reference documentation is copied from upstream and may retain Pi names, commands, and paths. For this fork, use `pie` instead of the upstream CLI command, `~/.pie` instead of `~/.pi/agent`, `.pie` instead of `.pi`, and the `PIE_CODING_AGENT_DIR` / `PIE_CODING_AGENT_SESSION_DIR` overrides. npm import names remain unchanged. Follow this README for Pie installation rather than upstream installer examples.

## Packages

| Package | Description |
|---------|-------------|
| [@earendil-works/chord](packages/chord) | Typed host runtime for hot-reloadable plugins and RPC |
| [@earendil-works/pi-telemetry](packages/telemetry) | Telemetry contracts, adapters, and schemas |
| [@earendil-works/pi-ai](packages/ai) | Unified multi-provider LLM API |
| [@earendil-works/pi-durable](packages/durable) | Durable conversation, task, and document runtime |
| [@earendil-works/pi-agent-core](packages/agent) | Agent runtime with tool calling and state management |
| [@earendil-works/pi-coding-agent](packages/coding-agent) | Pie CLI and coding-agent SDK in this checkout |
| [@earendil-works/pi-tui](packages/tui) | Terminal UI library |

## Permissions

Pie runs with the permissions of the user and process that launched it. Project trust controls resource loading; it does not sandbox tools. Subagent tool restrictions are not an operating-system sandbox.

Review [Security](packages/coding-agent/docs/security.md) and [Containerization](packages/coding-agent/docs/containerization.md) before running untrusted code or unattended automation. Containerization examples may use upstream command names; adapt them to the Pie checkout or local installation you actually run.

## Development

```bash
npm install --ignore-scripts  # Install dependencies without lifecycle scripts
npm run check                # Lint, format, and type check
./pi-test.sh                  # Run Pie from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for contributor and development rules. Dependency and lockfile changes require review; direct external dependencies are pinned, and CI installs use `npm ci --ignore-scripts`.

## Attribution and license

Pie builds on [Pi by Mario Zechner and its contributors](https://github.com/earendil-works/pi). Upstream project information is available at [pi.dev](https://pi.dev). The fork's changes are maintained in [chocotan/pie](https://github.com/chocotan/pie).

Licensed under [MIT](LICENSE). The original license remains unchanged. Bundled ports retain their own notices: [rpiv-ask-user-question](packages/coding-agent/docs/third-party/rpiv-ask-user-question-LICENSE), [pi-usage (MIT)](packages/coding-agent/docs/third-party/pi-usage/NOTICE.md), [pi-background-tasks (ISC)](packages/coding-agent/docs/third-party/pi-background-tasks/NOTICE.md), and [pi-retry (MIT)](packages/coding-agent/docs/third-party/pi-retry/NOTICE.md).
