# Pie

Pie is a source fork of [Pi](https://github.com/earendil-works/pi), originally created by **Mario Zechner**, with built-in Todo, isolated subagents, background shell jobs, structured user questions, Ponytail, a usage dashboard, and a compact terminal workflow.

The CLI command is `pie`. Global configuration lives directly in `~/.pie`, and project configuration lives in `.pie`. Overrides are `PIE_CODING_AGENT_DIR` and `PIE_CODING_AGENT_SESSION_DIR`. Earlier command names, directories and directory overrides are not compatibility aliases.

The Pie product version is tracked in `piConfig.version`; upstream SDK/npm package versions and `@earendil-works/*` import names remain independent. This source checkout ships the Pie CLI, not the upstream Pi installer.

See the [Pie project README](https://github.com/chocotan/pie/blob/main/README.md) for installation and updates, [Pie features](docs/pie.md) for workflow settings, and the [documentation index](docs/index.md) for SDK and extension APIs.

## Attribution

Pi was created by Mario Zechner and its contributors. Pie preserves the upstream MIT license and author metadata. See the [original license](https://github.com/earendil-works/pi/blob/main/LICENSE).
