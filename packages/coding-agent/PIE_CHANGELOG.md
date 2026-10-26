# Pie changelog

## [Unreleased]

### Added

- Searchable **Compaction model** picker in `/settings`, with a **Follow current model** choice and persistent configuration.
- Built-in `compact-model` plugin with a `compactModel` setting for using a separate model for manual and automatic compaction, preserving the default summary behavior and falling back on failure.
- Replaceable `retry` plugin that owns automatic retry while loaded, retrying every failed turn except context overflow, continuing output-limited responses, nudging empty ones, supporting a per-session subagent policy through a system-prompt matcher, and adding `/retry status|reset`. Adapted from pi-retry.
- `pi.setNativeRetryEnabled()` extension action, so a plugin that owns retry can disable the built-in agent-turn scheduler without patching private methods.

### Changed

- Installation, updates, release metadata and project links now use the renamed `chocotan/pie` GitHub repository.
- Todo and Subagents sort running work first and completed work last, show at most ten entries, and remove the oldest successful completions above ten records while preserving unfinished work.

## [0.1.1]

### Added

- Interactive startup offers to import Pi's `models.json` when Pie has none; importing requires confirmation and never overwrites an existing file.
- Replaceable built-in `/usage` dashboard, adapted from pi-usage, with day, week, month, all-time and calendar views of recorded tokens and costs.
- Replaceable background shell tools with bounded logs, process-tree cleanup, completion notifications and a top-right floating panel, adapted from pi-background-tasks.

### Fixed

- Startup now uses a two-row block-letter PIE logo.
- Todo and Subagents retain up to five visible entries and hide only overflow, including when all work has finished.

## [0.1.0]

### Added

- Replaceable built-in Todo, Subagent and structured user-question plugins.
- Floating task and subagent panels with independent child conversation views.
- Purpose-based tool titles, animated loading dots and colored completion dots.
- Clickable tool titles and hover feedback, including a transparent-theme fallback.

### Changed

- Pie uses the `pie` command and `.pie` global/project configuration directories.
- Pie has its own version, startup wordmark and update source.
- Tool output stays selectable; full commands and arguments remain available on expansion.

Pie is based on Pi by Mario Zechner. Upstream SDK packages and their release history retain their original authorship and versions.
