import type { InlineExtension } from "../core/extensions/types.ts";
import askUserExtension from "./ask-user/index.ts";
import backgroundExtension from "./background/index.ts";
import codemodeExtension from "./codemode/index.ts";
import compactModelExtension from "./compact-model/index.ts";
import continueWatchdogExtension from "./continue-watchdog/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import ponytailExtension from "./ponytail/index.ts";
import retryExtension from "./retry/index.ts";
import subagentsExtension from "./subagents/index.ts";
import tasksExtension from "./tasks/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import usageExtension from "./usage/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "ask-user-question", factory: askUserExtension, replaceable: true, builtin: true },
	{ name: "background", factory: backgroundExtension, replaceable: true, builtin: true },
	{ name: "continue-watchdog", factory: continueWatchdogExtension, replaceable: true, builtin: true },
	{ name: "compact-model", factory: compactModelExtension, builtin: true },
	{ name: "ponytail", factory: ponytailExtension, replaceable: true, builtin: true },
	{ name: "retry", factory: retryExtension, replaceable: true, builtin: true },
	{ name: "usage", factory: usageExtension, replaceable: true, builtin: true },
	{ name: "tasks", factory: tasksExtension, replaceable: true, builtin: true },
	{ name: "subagents", factory: subagentsExtension, replaceable: true, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
