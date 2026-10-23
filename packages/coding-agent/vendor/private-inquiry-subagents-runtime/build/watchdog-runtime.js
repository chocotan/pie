var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// ../../../../tmp/vrtbuild/src/shared/file-system-retry.ts
function resolveFileSystemRetryDelays(env = process.env, base = BASE_FILE_SYSTEM_RETRY_DELAYS_MS) {
  const raw = env[FS_RETRY_MAX_TOTAL_MS_ENV];
  if (raw === void 0 || raw.trim() === "") return base;
  const budget = Number(raw);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`${FS_RETRY_MAX_TOTAL_MS_ENV} must be a non-negative integer number of milliseconds.`);
  }
  let spent = 0;
  return base.map((delayMs) => {
    const allowed = Math.max(0, Math.min(delayMs, budget - spent));
    spent += allowed;
    return allowed;
  });
}
function waitForFileSystemRetry(delayMs) {
  if (delayMs <= 0) return;
  if (WAIT_VIEW) {
    try {
      Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
      return;
    } catch {
    }
  }
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
  }
}
function isRetryableFileSystemError(error) {
  const code = error?.code;
  return typeof code === "string" && RETRYABLE_FILE_SYSTEM_ERROR_CODES.has(code);
}
function runFileSystemOperationWithRetry(operation, options = {}) {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitForFileSystemRetry;
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === void 0 || !isRetryableFileSystemError(error)) throw error;
      wait(delayMs);
    }
  }
}
var WAIT_BUFFER, WAIT_VIEW, RETRYABLE_FILE_SYSTEM_ERROR_CODES, FS_RETRY_MAX_TOTAL_MS_ENV, BASE_FILE_SYSTEM_RETRY_DELAYS_MS, DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
var init_file_system_retry = __esm({
  "../../../../tmp/vrtbuild/src/shared/file-system-retry.ts"() {
    "use strict";
    WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : void 0;
    WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : void 0;
    RETRYABLE_FILE_SYSTEM_ERROR_CODES = /* @__PURE__ */ new Set(["EACCES", "EBUSY", "EPERM"]);
    FS_RETRY_MAX_TOTAL_MS_ENV = "PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS";
    BASE_FILE_SYSTEM_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1e3, 2e3, 4e3];
    DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS = resolveFileSystemRetryDelays();
  }
});

// ../../../../tmp/vrtbuild/src/shared/atomic-json.ts
import { createHash } from "node:crypto";
import * as fs2 from "node:fs";
import * as path2 from "node:path";
function renameWithRetry(fsImpl, sourcePath, targetPath, retryDelaysMs, wait) {
  runFileSystemOperationWithRetry(() => {
    fsImpl.renameSync(sourcePath, targetPath);
  }, { retryDelaysMs, wait });
}
function tempBaseName(filePath, pid, nowMs, randomId) {
  const suffix = `.${pid}.${nowMs}.${randomId}.tmp`;
  const preferred = `.${path2.basename(filePath)}${suffix}`;
  if (Buffer.byteLength(preferred, "utf-8") <= MAX_PATH_COMPONENT_BYTES) return preferred;
  return `.${createHash("sha256").update(path2.basename(filePath)).digest("hex")}${suffix}`;
}
function createAtomicJsonWriter(options = {}) {
  const fsImpl = options.fs ?? fs2;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const random = options.random ?? Math.random;
  const mode = options.mode;
  const retryRenameErrors = options.retryRenameErrors ?? process.platform === "win32";
  const retryDirectoryErrors = options.retryDirectoryErrors ?? retryRenameErrors;
  const ignoreCleanupErrorAfterSuccess = options.ignoreCleanupErrorAfterSuccess ?? false;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
  const renameRetryDelaysMs = retryRenameErrors ? retryDelaysMs : [];
  const directoryRetryDelaysMs = retryDirectoryErrors ? retryDelaysMs : [];
  const wait = options.wait ?? waitForFileSystemRetry;
  return (filePath, payload, beforeRename) => {
    runFileSystemOperationWithRetry(() => {
      fsImpl.mkdirSync(path2.dirname(filePath), { recursive: true });
    }, { retryDelaysMs: directoryRetryDelaysMs, wait });
    const tempPath = path2.join(
      path2.dirname(filePath),
      tempBaseName(filePath, pid, now(), random().toString(36).slice(2))
    );
    let writeError;
    try {
      fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), mode === void 0 ? "utf-8" : { encoding: "utf-8", mode });
      beforeRename?.();
      renameWithRetry(fsImpl, tempPath, filePath, renameRetryDelaysMs, wait);
    } catch (error) {
      writeError = error;
      throw error;
    } finally {
      try {
        fsImpl.rmSync(tempPath, { force: true });
      } catch (cleanupError) {
        if (writeError === void 0 && !ignoreCleanupErrorAfterSuccess) throw cleanupError;
      }
    }
  };
}
var MAX_PATH_COMPONENT_BYTES, writeAtomicJson, writePrivateAtomicJson;
var init_atomic_json = __esm({
  "../../../../tmp/vrtbuild/src/shared/atomic-json.ts"() {
    "use strict";
    init_file_system_retry();
    MAX_PATH_COMPONENT_BYTES = 255;
    writeAtomicJson = createAtomicJsonWriter();
    writePrivateAtomicJson = createAtomicJsonWriter({ mode: 384 });
  }
});

// ../../../../tmp/vrtbuild/src/shared/types.ts
import * as os from "node:os";
import * as path3 from "node:path";
function sanitizeTempScopeSegment(value) {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}
function resolveTempScopeId(options) {
  const env = options?.env ?? process.env;
  const getuid = options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === "function") {
    return `uid-${getuid()}`;
  }
  for (const key of ["USERNAME", "USER", "LOGNAME"]) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  const userInfo2 = options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
  try {
    const username = userInfo2?.().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
  }
  const homedir4 = env.USERPROFILE ?? env.HOME;
  if (homedir4) return `home-${sanitizeTempScopeSegment(homedir4)}`;
  const resolveHomedir = options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
  try {
    const fallbackHomedir = resolveHomedir?.();
    if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
  } catch {
  }
  return "shared";
}
var DEFAULT_MAX_OUTPUT, configuredTempRoot, TEMP_ROOT_DIR, RESULTS_DIR, ASYNC_DIR, CHAIN_RUNS_DIR, TEMP_ARTIFACTS_DIR, POLL_INTERVAL_MS;
var init_types = __esm({
  "../../../../tmp/vrtbuild/src/shared/types.ts"() {
    "use strict";
    DEFAULT_MAX_OUTPUT = {
      bytes: 200 * 1024,
      lines: 5e3
    };
    configuredTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
    TEMP_ROOT_DIR = configuredTempRoot ? path3.resolve(configuredTempRoot) : path3.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
    RESULTS_DIR = path3.join(TEMP_ROOT_DIR, "async-subagent-results");
    ASYNC_DIR = path3.join(TEMP_ROOT_DIR, "async-subagent-runs");
    CHAIN_RUNS_DIR = path3.join(TEMP_ROOT_DIR, "chain-runs");
    TEMP_ARTIFACTS_DIR = path3.join(TEMP_ROOT_DIR, "artifacts");
    POLL_INTERVAL_MS = 250;
  }
});

// ../../../../tmp/vrtbuild/src/shared/display-text.ts
var init_display_text = __esm({
  "../../../../tmp/vrtbuild/src/shared/display-text.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/shared/file-lease.ts
var init_file_lease = __esm({
  "../../../../tmp/vrtbuild/src/shared/file-lease.ts"() {
    "use strict";
    init_file_system_retry();
  }
});

// ../../../../tmp/vrtbuild/src/shared/settings-file-lease.ts
var init_settings_file_lease = __esm({
  "../../../../tmp/vrtbuild/src/shared/settings-file-lease.ts"() {
    "use strict";
    init_file_lease();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/external-cli-contract.ts
var UNSUPPORTED, CAPABILITY_KEYS, PROMPT_FILE_UNSUPPORTED, CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS, CODE_OWNED_EXTERNAL_CLI_ADAPTER_ID_SET, CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL;
var init_external_cli_contract = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/external-cli-contract.ts"() {
    "use strict";
    UNSUPPORTED = {
      steer: "The one-shot stdin adapter closes input after launch and cannot accept live steer messages.",
      resume: "The one-shot stdin adapter has no durable external session identity.",
      structuredOutput: "The generic external CLI adapter does not parse a trusted structured result.",
      toolEvents: "The generic external CLI adapter treats stdout as untrusted text, not native Pi tool events.",
      supervisor: "The generic external CLI adapter has no trusted supervisor event transport.",
      forkContext: "Native Pi fork context is not available without an adapter-owned handoff artifact.",
      extensionBindings: "Native Pi extension bindings are never passed to external runners."
    };
    CAPABILITY_KEYS = new Set(Object.keys(UNSUPPORTED));
    PROMPT_FILE_UNSUPPORTED = {
      ...UNSUPPORTED,
      steer: "The one-shot prompt-file adapter closes input after launch and cannot accept live steer messages.",
      resume: "The one-shot prompt-file adapter does not retain a durable external session identity."
    };
    CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS = [
      "codex-exec",
      "codex-exec-writer",
      "claude-code",
      "claude-code-writer",
      "cursor-agent",
      "cursor-agent-writer"
    ];
    CODE_OWNED_EXTERNAL_CLI_ADAPTER_ID_SET = new Set(CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS);
    CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL = CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS.map((id2) => `'${id2}'`).join(", ");
  }
});

// ../../../../tmp/vrtbuild/src/runs/background/owned-process-tree.ts
var init_owned_process_tree = __esm({
  "../../../../tmp/vrtbuild/src/runs/background/owned-process-tree.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/extension-bindings.ts
var MAX_EXTENSION_BINDINGS_BYTES;
var init_extension_bindings = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/extension-bindings.ts"() {
    "use strict";
    MAX_EXTENSION_BINDINGS_BYTES = 16 * 1024;
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/git-environment.ts
var init_git_environment = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/git-environment.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/shared/node-executable.ts
var init_node_executable = __esm({
  "../../../../tmp/vrtbuild/src/shared/node-executable.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/external-cli-preflight.ts
var MAX_PROBE_OUTPUT_BYTES;
var init_external_cli_preflight = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/external-cli-preflight.ts"() {
    "use strict";
    init_node_executable();
    MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/external-cli-runner.ts
var MAX_OUTPUT_TAIL_BYTES, MAX_ERROR_TAIL_BYTES, MAX_RAW_LOG_BYTES, MAX_PARSER_LINE_BYTES, MAX_PARSER_STREAM_BYTES, MAX_PARSER_OUTPUT_BYTES, MAX_SKIPPABLE_LINE_BYTES;
var init_external_cli_runner = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/external-cli-runner.ts"() {
    "use strict";
    init_utils();
    init_owned_process_tree();
    init_extension_bindings();
    init_git_environment();
    init_external_cli_preflight();
    MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
    MAX_ERROR_TAIL_BYTES = 64 * 1024;
    MAX_RAW_LOG_BYTES = 8 * 1024 * 1024;
    MAX_PARSER_LINE_BYTES = 256 * 1024;
    MAX_PARSER_STREAM_BYTES = 32 * 1024 * 1024;
    MAX_PARSER_OUTPUT_BYTES = 1024 * 1024;
    MAX_SKIPPABLE_LINE_BYTES = 1024 * 1024;
  }
});

// ../../../../tmp/vrtbuild/src/shared/model-info.ts
function toModelInfo(model2) {
  return {
    provider: model2.provider,
    id: model2.id,
    fullId: `${model2.provider}/${model2.id}`,
    api: model2.api,
    reasoning: model2.reasoning,
    thinkingLevelMap: model2.thinkingLevelMap,
    ...typeof model2.contextWindow === "number" && Number.isFinite(model2.contextWindow) && model2.contextWindow > 0 ? { contextWindow: model2.contextWindow } : {},
    ...typeof model2.maxTokens === "number" && Number.isFinite(model2.maxTokens) && model2.maxTokens > 0 ? { maxTokens: model2.maxTokens } : {},
    ...Array.isArray(model2.input) && model2.input.length > 0 ? { input: [...model2.input] } : {},
    ...model2.cost && Number.isFinite(model2.cost.input) && Number.isFinite(model2.cost.output) ? { cost: { ...model2.cost, ...model2.cost.tiers ? { tiers: model2.cost.tiers.map((tier) => ({ ...tier })) } : {} } } : {}
  };
}
function resolveEffectiveThinking(model2, configThinking) {
  if (!model2) return void 0;
  const { thinkingSuffix } = splitKnownThinkingSuffix(model2);
  if (thinkingSuffix) return thinkingSuffix.slice(1);
  return THINKING_LEVELS.find((level) => level === configThinking);
}
function splitKnownThinkingSuffix(model2) {
  const colonIdx = model2.lastIndexOf(":");
  if (colonIdx === -1) return { baseModel: model2, thinkingSuffix: "" };
  const suffix = THINKING_LEVELS.find((level) => level === model2.substring(colonIdx + 1));
  if (!suffix) return { baseModel: model2, thinkingSuffix: "" };
  return {
    baseModel: model2.substring(0, colonIdx),
    thinkingSuffix: `:${suffix}`
  };
}
var THINKING_LEVELS;
var init_model_info = __esm({
  "../../../../tmp/vrtbuild/src/shared/model-info.ts"() {
    "use strict";
    THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
});

// ../../../../tmp/vrtbuild/src/shared/thinking-ceiling.ts
var thinkingLevelRanks;
var init_thinking_ceiling = __esm({
  "../../../../tmp/vrtbuild/src/shared/thinking-ceiling.ts"() {
    "use strict";
    init_model_info();
    thinkingLevelRanks = new Map(THINKING_LEVELS.map((level, index) => [level, index]));
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/model-scope.ts
var init_model_scope = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/model-scope.ts"() {
    "use strict";
    init_model_info();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/claude-code-adapter.ts
var init_claude_code_adapter = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/claude-code-adapter.ts"() {
    "use strict";
    init_external_cli_runner();
    init_model_info();
    init_thinking_ceiling();
    init_model_scope();
  }
});

// ../../../../tmp/vrtbuild/src/agents/identity.ts
var init_identity = __esm({
  "../../../../tmp/vrtbuild/src/agents/identity.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/agents/agent-serializer.ts
import { stringify as stringifyYaml } from "yaml";
var init_agent_serializer = __esm({
  "../../../../tmp/vrtbuild/src/agents/agent-serializer.ts"() {
    "use strict";
    init_identity();
  }
});

// ../../../../tmp/vrtbuild/src/agents/frontmatter.ts
var init_frontmatter = __esm({
  "../../../../tmp/vrtbuild/src/agents/frontmatter.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/pi-spawn.ts
var init_pi_spawn = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/pi-spawn.ts"() {
    "use strict";
    init_utils();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/structured-output.ts
var init_structured_output = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/structured-output.ts"() {
    "use strict";
    init_utils();
    init_pi_spawn();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/dynamic-fanout.ts
var DYNAMIC_STEP_KEYS, RUNNER_DYNAMIC_STEP_KEYS, DYNAMIC_PARALLEL_KEYS, RUNNER_DYNAMIC_PARALLEL_KEYS;
var init_dynamic_fanout = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/dynamic-fanout.ts"() {
    "use strict";
    init_utils();
    init_structured_output();
    DYNAMIC_STEP_KEYS = /* @__PURE__ */ new Set(["expand", "parallel", "collect", "concurrency", "failFast", "phase", "label", "acceptance", "agentContract", "gateOn"]);
    RUNNER_DYNAMIC_STEP_KEYS = /* @__PURE__ */ new Set([...DYNAMIC_STEP_KEYS, "effectiveAcceptance", "acceptanceInput", "acceptanceRole", "sessionFiles", "thinkingOverrides"]);
    DYNAMIC_PARALLEL_KEYS = /* @__PURE__ */ new Set(["agent", "task", "phase", "label", "outputSchema", "cwd", "machine", "output", "outputMode", "reads", "progress", "skill", "model", "fast", "toolBudget", "acceptance", "agentContract", "gateOn"]);
    RUNNER_DYNAMIC_PARALLEL_KEYS = /* @__PURE__ */ new Set([
      ...DYNAMIC_PARALLEL_KEYS,
      "runner",
      "outputName",
      "structured",
      "inheritProjectContext",
      "inheritGlobalContext",
      "inheritSkills",
      "skills",
      "outputPath",
      "namespaceOutputPath",
      "maxSubagentDepth",
      "timeoutMs",
      "waitToolEnabled",
      "waitToolDefaultTimeoutMs",
      "structuredOutput",
      "structuredOutputSchema",
      "tools",
      "excludeTools",
      "allowNestedSubagents",
      "extensions",
      "subagentOnlyExtensions",
      "mcpDirectTools",
      "builtinMcpTools",
      "mutationTools",
      "capabilityCeiling",
      "systemPrompt",
      "systemPromptMode",
      "thinking",
      "requestedModel",
      "sessionFile",
      "effectiveAcceptance",
      "acceptanceInput",
      "acceptanceRole",
      "parentSessionId",
      "parentSessionFile",
      "requiredExtensions",
      "launchResolvedExtensions",
      "requestedCwd",
      "machineEnv"
    ]);
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/chain-outputs.ts
var init_chain_outputs = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/chain-outputs.ts"() {
    "use strict";
    init_settings();
    init_utils();
    init_dynamic_fanout();
  }
});

// ../../../../tmp/vrtbuild/src/watchdog/types.ts
var WATCHDOG_WARNING_SEVERITIES, WATCHDOG_WARNING_CATEGORIES, WATCHDOG_WARNING_IMPORTANCES;
var init_types2 = __esm({
  "../../../../tmp/vrtbuild/src/watchdog/types.ts"() {
    "use strict";
    WATCHDOG_WARNING_SEVERITIES = ["concern", "blocker"];
    WATCHDOG_WARNING_CATEGORIES = [
      "correctness",
      "missed-constraint",
      "test-gap",
      "unsafe-change",
      "scope-drift",
      "stale-fact",
      "loop-risk",
      "other"
    ];
    WATCHDOG_WARNING_IMPORTANCES = ["low", "medium", "high"];
  }
});

// ../../../../tmp/vrtbuild/src/watchdog/child-status.ts
function childConfigObject(value, field) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new Error(`Invalid child watchdog config: ${field} must be an object.`);
}
function childConfigOptionalString(input, field) {
  if (!(field in input)) return void 0;
  const value = input[field];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Invalid child watchdog config: ${field} must be a non-empty string.`);
}
function childConfigOptionalIndex(input, field) {
  if (!(field in input)) return void 0;
  const value = input[field];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`Invalid child watchdog config: ${field} must be a non-negative integer.`);
}
function childConfigPositiveInteger(input, field) {
  const value = input[field];
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw new Error(`Invalid child watchdog config: ${field} must be a positive integer.`);
}
function childConfigNullableNonNegativeInteger(input, field) {
  const value = input[field];
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`Invalid child watchdog config: ${field} must be null or a non-negative integer.`);
}
function childConfigCadence(value) {
  const input = childConfigObject(value, "cadence");
  const everyNTools = input.everyNTools;
  if (everyNTools === null) return { everyNTools: null };
  if (typeof everyNTools === "number" && Number.isInteger(everyNTools) && everyNTools >= 5) return { everyNTools };
  throw new Error("Invalid child watchdog config: cadence.everyNTools must be null or an integer >= 5.");
}
function childConfigLsp(value) {
  const input = childConfigObject(value, "lsp");
  if (typeof input.enabled !== "boolean") throw new Error("Invalid child watchdog config: lsp.enabled must be a boolean.");
  if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("Invalid child watchdog config: lsp.timeoutMs must be a positive integer.");
  }
  if (typeof input.maxFiles !== "number" || !Number.isInteger(input.maxFiles) || input.maxFiles < 1) {
    throw new Error("Invalid child watchdog config: lsp.maxFiles must be a positive integer.");
  }
  if (typeof input.maxDiagnostics !== "number" || !Number.isInteger(input.maxDiagnostics) || input.maxDiagnostics < 0) {
    throw new Error("Invalid child watchdog config: lsp.maxDiagnostics must be a non-negative integer.");
  }
  return {
    enabled: input.enabled,
    timeoutMs: input.timeoutMs,
    maxFiles: input.maxFiles,
    maxDiagnostics: input.maxDiagnostics
  };
}
function decodeChildWatchdogConfig(raw) {
  if (!raw) return void 0;
  const parsed = childConfigObject(JSON.parse(raw), "root");
  if (Object.hasOwn(parsed, "fallbackModels")) {
    throw new Error("Invalid child watchdog config: fallbackModels was removed; configure one model instead.");
  }
  if (parsed.enabled === false) return void 0;
  if ("enabled" in parsed && parsed.enabled !== true) throw new Error("Invalid child watchdog config: enabled must be true or false.");
  const thinking = parsed.thinking;
  if (thinking !== void 0 && typeof thinking !== "string" && thinking !== false) {
    throw new Error("Invalid child watchdog config: thinking must be a string or false.");
  }
  const runId = childConfigOptionalString(parsed, "runId");
  const agent2 = childConfigOptionalString(parsed, "agent");
  const childIndex = childConfigOptionalIndex(parsed, "childIndex");
  const model2 = childConfigOptionalString(parsed, "model");
  return {
    ...runId ? { runId } : {},
    ...agent2 ? { agent: agent2 } : {},
    ...childIndex !== void 0 ? { childIndex } : {},
    watchdogTailTimeoutMs: childConfigPositiveInteger(parsed, "watchdogTailTimeoutMs"),
    agentEndTimeoutMs: childConfigPositiveInteger(parsed, "agentEndTimeoutMs"),
    maxWarnings: childConfigNullableNonNegativeInteger(parsed, "maxWarnings"),
    ...model2 ? { model: model2 } : {},
    ...thinking !== void 0 ? { thinking } : {},
    lsp: childConfigLsp(parsed.lsp),
    stalemateRepeats: childConfigPositiveInteger(parsed, "stalemateRepeats"),
    cadence: childConfigCadence(parsed.cadence)
  };
}
var init_child_status = __esm({
  "../../../../tmp/vrtbuild/src/watchdog/child-status.ts"() {
    "use strict";
    init_types2();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/agent-contract.ts
var init_agent_contract = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/agent-contract.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/acceptance.ts
var VALID_EVIDENCE_KINDS, VALID_EVIDENCE, ACCEPTANCE_EVIDENCE_HELP;
var init_acceptance = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/acceptance.ts"() {
    "use strict";
    init_child_status();
    init_agent_contract();
    init_structured_output();
    VALID_EVIDENCE_KINDS = [
      "changed-files",
      "tests-added",
      "commands-run",
      "validation-output",
      "residual-risks",
      "no-staged-files",
      "diff-summary",
      "review-findings",
      "manual-notes"
    ];
    VALID_EVIDENCE = new Set(VALID_EVIDENCE_KINDS);
    ACCEPTANCE_EVIDENCE_HELP = `Supported evidence kinds: ${VALID_EVIDENCE_KINDS.join(", ")}. Example: { level: "checked", evidence: ["commands-run", "changed-files"] }.`;
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/tool-budget.ts
var init_tool_budget = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/tool-budget.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/agents/chain-serializer.ts
var init_chain_serializer = __esm({
  "../../../../tmp/vrtbuild/src/agents/chain-serializer.ts"() {
    "use strict";
    init_identity();
    init_frontmatter();
    init_chain_outputs();
    init_acceptance();
    init_tool_budget();
  }
});

// ../../../../tmp/vrtbuild/src/agents/agent-selection.ts
var init_agent_selection = __esm({
  "../../../../tmp/vrtbuild/src/agents/agent-selection.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/agents/agent-scope.ts
var init_agent_scope = __esm({
  "../../../../tmp/vrtbuild/src/agents/agent-scope.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/shared/edit-distance.ts
var init_edit_distance = __esm({
  "../../../../tmp/vrtbuild/src/shared/edit-distance.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/agents/builtin-names.ts
var init_builtin_names = __esm({
  "../../../../tmp/vrtbuild/src/agents/builtin-names.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/agents/agent-memory.ts
var MAX_MEMORY_BYTES, MAX_GITDIR_FILE_BYTES;
var init_agent_memory = __esm({
  "../../../../tmp/vrtbuild/src/agents/agent-memory.ts"() {
    "use strict";
    init_utils();
    init_agents();
    MAX_MEMORY_BYTES = 16 * 1024;
    MAX_GITDIR_FILE_BYTES = 4 * 1024;
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/permissions.ts
import * as fs3 from "node:fs";
import * as path4 from "node:path";
function redactSecretValues(value) {
  return value.replace(SECRET_VALUE, "[redacted]");
}
function redact(value, key = "", depth = 0) {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, "", depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 20).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, depth + 1)]));
  if (typeof value === "string") {
    const redacted = redactSecretValues(value);
    return redacted.length > 500 ? `${redacted.slice(0, 500)}\u2026` : redacted;
  }
  return value;
}
function permissionArgsPreview(input) {
  const serialized = JSON.stringify(redact(input));
  if (!serialized) return "{}";
  if (Buffer.byteLength(serialized, "utf-8") <= MAX_PREVIEW_BYTES) return serialized;
  const maxContentBytes = MAX_PREVIEW_BYTES - Buffer.byteLength("\u2026", "utf-8");
  let preview = "";
  let previewBytes = 0;
  for (const character of serialized) {
    const characterBytes = Buffer.byteLength(character, "utf-8");
    if (previewBytes + characterBytes > maxContentBytes) break;
    preview += character;
    previewBytes += characterBytes;
  }
  return `${preview}\u2026`;
}
function appendPermissionAudit(filePath, record) {
  if (!filePath) return;
  fs3.mkdirSync(path4.dirname(filePath), { recursive: true, mode: 448 });
  fs3.appendFileSync(filePath, `${JSON.stringify(record)}
`, { encoding: "utf-8", mode: 384 });
}
var MAX_POLICY_BYTES, MAX_PREVIEW_BYTES, SECRET_KEY, SECRET_VALUE;
var init_permissions = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/permissions.ts"() {
    "use strict";
    MAX_POLICY_BYTES = 16 * 1024;
    MAX_PREVIEW_BYTES = 2048;
    SECRET_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;
    SECRET_VALUE = /\b(?:Bearer\s+\S+|(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})\b/gi;
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/capability-ceiling.ts
var init_capability_ceiling = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/capability-ceiling.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/agents/agents.ts
import * as fs4 from "node:fs";
import { parse as parseYaml } from "yaml";
import * as path5 from "node:path";
import { fileURLToPath } from "node:url";
function isDiscoveryNestedProjectRoot(dir) {
  return isDirectory(getProjectConfigDir(dir)) || isDirectory(path5.join(dir, ".agents"));
}
function shouldPruneDiscoveryDir(rootDir, dir, dirName) {
  if (DISCOVERY_PRUNED_DIR_NAMES.has(dirName)) return true;
  if (fs4.existsSync(path5.join(dir, ".git"))) return true;
  return path5.resolve(dir) !== path5.resolve(rootDir) && isDiscoveryNestedProjectRoot(dir);
}
function rememberAgentDefinitionInspection(inspection, directories) {
  agentDefinitionInspectionDirectories.set(inspection, [...new Set([...directories].map((directory) => path5.resolve(directory)))]);
  return inspection;
}
function inspectAgentDefinitionDirectory(dir, operations = DEFAULT_AGENT_DEFINITION_INSPECTION_FS, isExcluded = () => false) {
  const root = path5.resolve(dir);
  if (isExcluded(root)) return rememberAgentDefinitionInspection({ files: [], state: "empty" }, []);
  try {
    if (!operations.existsSync(root)) return rememberAgentDefinitionInspection({ files: [], state: "absent" }, [root]);
    if (!operations.statSync(root).isDirectory()) return rememberAgentDefinitionInspection({ files: [], state: "not-directory" }, [root]);
  } catch {
    return rememberAgentDefinitionInspection({ files: [], state: "unreadable" }, [root]);
  }
  const files = [];
  let unreadable = false;
  const visitedDirectories = /* @__PURE__ */ new Set();
  const inspectedDirectories = /* @__PURE__ */ new Set();
  const visit = (current) => {
    inspectedDirectories.add(path5.resolve(current));
    let realDir;
    try {
      realDir = operations.realpathSync?.(current) ?? path5.resolve(current);
    } catch {
      unreadable = true;
      return;
    }
    if (visitedDirectories.has(realDir)) return;
    visitedDirectories.add(realDir);
    let entries;
    try {
      entries = operations.readdirSync(current).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      unreadable = true;
      return;
    }
    for (const entry of entries) {
      const filePath = path5.join(current, entry.name);
      if (isExcluded(filePath)) continue;
      let isDirectory2 = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory2 = operations.statSync(filePath).isDirectory();
        } catch {
          isDirectory2 = false;
        }
      }
      if (isDirectory2) {
        if (!shouldPruneDiscoveryDir(root, filePath, entry.name)) visit(filePath);
        continue;
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md") && !isLegacyAgentSkillPath(root, filePath)) files.push(filePath);
    }
  };
  visit(root);
  return rememberAgentDefinitionInspection({ files, state: unreadable ? "unreadable" : files.length ? "candidates" : "empty" }, inspectedDirectories);
}
function isLegacyAgentSkillPath(rootDir, filePath) {
  const relative5 = path5.relative(rootDir, filePath);
  const parts = relative5.split(path5.sep).map((part) => part.toLowerCase());
  if (path5.basename(rootDir).toLowerCase() === ".agents") {
    parts.unshift(".agents");
  }
  return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}
function readAgentDefinitionFiles(dir, inspection = inspectAgentDefinitionDirectory(dir)) {
  const files = [];
  for (const filePath of inspection.files) {
    if (isLegacyAgentSkillPath(dir, filePath)) {
      continue;
    }
    try {
      files.push({ filePath, content: fs4.readFileSync(filePath, "utf-8") });
    } catch {
      continue;
    }
  }
  return files;
}
function isDirectory(p) {
  try {
    return fs4.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
var DISCOVERY_PRUNED_DIR_NAMES, agentDefinitionInspectionDirectories, DEFAULT_AGENT_DEFINITION_INSPECTION_FS, BUILTIN_AGENTS_DIR, BUILTIN_AGENT_DEFINITION_INSPECTION, BUILTIN_AGENT_DEFINITION_FILES;
var init_agents = __esm({
  "../../../../tmp/vrtbuild/src/agents/agents.ts"() {
    "use strict";
    init_atomic_json();
    init_settings_file_lease();
    init_types();
    init_external_cli_contract();
    init_claude_code_adapter();
    init_utils();
    init_settings();
    init_agent_serializer();
    init_chain_serializer();
    init_agent_selection();
    init_agent_scope();
    init_edit_distance();
    init_frontmatter();
    init_identity();
    init_model_scope();
    init_builtin_names();
    init_identity();
    init_agent_memory();
    init_acceptance();
    init_permissions();
    init_thinking_ceiling();
    init_structured_output();
    init_capability_ceiling();
    DISCOVERY_PRUNED_DIR_NAMES = /* @__PURE__ */ new Set([".git", "node_modules", ".pi", "sync-backups"]);
    agentDefinitionInspectionDirectories = /* @__PURE__ */ new WeakMap();
    DEFAULT_AGENT_DEFINITION_INSPECTION_FS = {
      existsSync: fs4.existsSync,
      realpathSync: fs4.realpathSync,
      statSync: fs4.statSync,
      readdirSync: (dir) => fs4.readdirSync(dir, { withFileTypes: true })
    };
    BUILTIN_AGENTS_DIR = path5.resolve(path5.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
    BUILTIN_AGENT_DEFINITION_INSPECTION = inspectAgentDefinitionDirectory(BUILTIN_AGENTS_DIR);
    BUILTIN_AGENT_DEFINITION_FILES = readAgentDefinitionFiles(BUILTIN_AGENTS_DIR, BUILTIN_AGENT_DEFINITION_INSPECTION);
  }
});

// ../../../../tmp/vrtbuild/src/agents/skills.ts
import { parse as parseYaml2 } from "yaml";
var init_skills = __esm({
  "../../../../tmp/vrtbuild/src/agents/skills.ts"() {
    "use strict";
    init_frontmatter();
    init_utils();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/single-output.ts
var MAX_FULL_OUTPUT_FILE_BYTES;
var init_single_output = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/single-output.ts"() {
    "use strict";
    MAX_FULL_OUTPUT_FILE_BYTES = 50 * 1024 * 1024;
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/child-launch-plan.ts
var init_child_launch_plan = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/child-launch-plan.ts"() {
    "use strict";
    init_utils();
    init_single_output();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/parallel-utils.ts
var init_parallel_utils = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/parallel-utils.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/shared/settings.ts
var CHAIN_DIR_MAX_AGE_MS;
var init_settings = __esm({
  "../../../../tmp/vrtbuild/src/shared/settings.ts"() {
    "use strict";
    init_agents();
    init_skills();
    init_child_launch_plan();
    init_types();
    init_child_launch_plan();
    init_parallel_utils();
    CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
  }
});

// ../../../../tmp/vrtbuild/src/shared/formatters.ts
var init_formatters = __esm({
  "../../../../tmp/vrtbuild/src/shared/formatters.ts"() {
    "use strict";
    init_settings();
    init_display_text();
    init_model_info();
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/lane-metadata.ts
var init_lane_metadata = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/lane-metadata.ts"() {
    "use strict";
  }
});

// ../../../../tmp/vrtbuild/src/runs/shared/model-resolution.ts
function normalizeModelSegment(segment) {
  return segment.toLowerCase().replace(/[._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function isPlausibleDateStamp(year, month, day) {
  const yyyy = Number(year);
  const mm = Number(month);
  const dd = Number(day);
  return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}
function stripTrailingDateStamp(segment) {
  const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
  if (dashed && isPlausibleDateStamp(dashed[2], dashed[3], dashed[4])) return dashed[1];
  const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
  if (compact && isPlausibleDateStamp(compact[2], compact[3], compact[4])) return compact[1];
  return segment;
}
function isRegisteredProvider(provider, availableModels) {
  const normalized = normalizeModelSegment(provider);
  return availableModels.some((entry) => normalizeModelSegment(entry.provider) === normalized);
}
function splitQualifiedModelQuery(baseModel, availableModels) {
  const slashIdx = baseModel.indexOf("/");
  if (slashIdx !== -1) {
    const providerPart = baseModel.slice(0, slashIdx);
    if (isRegisteredProvider(providerPart, availableModels)) {
      return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(slashIdx + 1) };
    }
    return { queryIdRaw: baseModel };
  }
  const providerSeparators = [":", "."];
  for (const separator of providerSeparators) {
    const separatorIdx = baseModel.indexOf(separator);
    if (separatorIdx <= 0) continue;
    const providerPart = baseModel.slice(0, separatorIdx);
    if (!isRegisteredProvider(providerPart, availableModels)) continue;
    return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(separatorIdx + 1) };
  }
  return { queryIdRaw: baseModel };
}
function resolveExactIdMatches(baseModel, availableModels, preferredProvider) {
  const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
  if (preferredProvider) {
    const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
    if (preferredMatch) return preferredMatch.fullId;
  }
  if (exactMatches.length === 1) return exactMatches[0].fullId;
  return void 0;
}
function resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) {
  const exact = availableModels.find((entry) => entry.fullId === baseModel);
  if (exact) return exact.fullId;
  const { queryProvider } = splitQualifiedModelQuery(baseModel, availableModels);
  if (queryProvider === void 0) {
    const exactId = resolveExactIdMatches(baseModel, availableModels, preferredProvider);
    if (exactId) return exactId;
  }
  const fuzzy = fuzzyResolveModel(baseModel, availableModels, preferredProvider);
  if (fuzzy || queryProvider === void 0) return fuzzy;
  const queryId = normalizeModelSegment(baseModel);
  const prefixedIdMatches = availableModels.filter((entry) => normalizeModelSegment(entry.id) === queryId && normalizeModelSegment(entry.provider) === queryProvider);
  return prefixedIdMatches.length === 1 ? prefixedIdMatches[0].fullId : void 0;
}
function fuzzyResolveModel(baseModel, availableModels, preferredProvider) {
  const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
  const queryId = normalizeModelSegment(queryIdRaw);
  const queryIdNoDate = stripTrailingDateStamp(queryId);
  const candidates = availableModels.filter((entry) => {
    const entryId = normalizeModelSegment(entry.id);
    if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
    if (queryProvider !== void 0 && normalizeModelSegment(entry.provider) !== queryProvider) return false;
    return true;
  });
  if (candidates.length === 0) return void 0;
  if (preferredProvider) {
    const preferredProviderNorm = normalizeModelSegment(preferredProvider);
    const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
    if (preferred) return preferred.fullId;
  }
  if (candidates.length === 1) return candidates[0].fullId;
  return void 0;
}
function resolveModelCandidate(model2, availableModels, preferredProvider) {
  if (!model2) return void 0;
  if (!availableModels || availableModels.length === 0) return model2;
  const resolvedWhole = resolveBaseModelCandidate(model2, availableModels, preferredProvider);
  if (resolvedWhole) return resolvedWhole;
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model2);
  if (!thinkingSuffix) return model2;
  const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
  if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
  return model2;
}
var init_model_resolution = __esm({
  "../../../../tmp/vrtbuild/src/runs/shared/model-resolution.ts"() {
    "use strict";
    init_model_info();
    init_model_scope();
    init_edit_distance();
  }
});

// ../../../../tmp/vrtbuild/src/shared/utils.ts
import * as fs5 from "node:fs";
import * as os2 from "node:os";
import * as path6 from "node:path";
function resolveWatchPath(watchPath, nativeRealpath = fs5.realpathSync.native) {
  try {
    return nativeRealpath(watchPath);
  } catch {
    return watchPath;
  }
}
function validConfigDirName(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function readConfigDirNameFromPackageRoot(packageRoot) {
  if (!packageRoot) return void 0;
  try {
    const pkg = JSON.parse(fs5.readFileSync(path6.join(packageRoot, "package.json"), "utf-8"));
    if (pkg.name !== PI_CODING_AGENT_PACKAGE_NAME) return void 0;
    return validConfigDirName(pkg.piConfig?.configDir);
  } catch {
    return void 0;
  }
}
function resolveConfigDirNameFromPackageJson(entryPoint = process.argv[1], packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]) {
  const packageRootValue = readConfigDirNameFromPackageRoot(packageRoot);
  if (packageRootValue) return packageRootValue;
  if (!entryPoint) return void 0;
  try {
    let dir = path6.dirname(fs5.realpathSync(entryPoint));
    while (dir !== path6.dirname(dir)) {
      const value = readConfigDirNameFromPackageRoot(dir);
      if (value) return value;
      dir = path6.dirname(dir);
    }
  } catch {
  }
  return void 0;
}
function resolveConfigDirName(codingAgentModule, entryPoint, packageRoot) {
  const moduleValue = codingAgentModule && typeof codingAgentModule === "object" ? validConfigDirName(codingAgentModule.CONFIG_DIR_NAME) : void 0;
  return moduleValue ?? resolveConfigDirNameFromPackageJson(entryPoint, packageRoot) ?? DEFAULT_CONFIG_DIR_NAME;
}
function getConfigDirName() {
  const entryPoint = process.argv[1];
  const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
  if (cachedConfigDirName && cachedConfigDirName.entryPoint === entryPoint && cachedConfigDirName.packageRoot === packageRoot) {
    return cachedConfigDirName.value;
  }
  const value = resolveConfigDirName(void 0, entryPoint, packageRoot);
  cachedConfigDirName = { entryPoint, packageRoot, value };
  return value;
}
function getProjectConfigDir(projectRoot) {
  return path6.join(projectRoot, getConfigDirName());
}
function getAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || os2.homedir();
  if (configured === "~") return home;
  if (configured?.startsWith("~/") || configured?.startsWith("~\\")) return path6.join(home, configured.slice(2));
  return configured || path6.join(home, getConfigDirName(), "agent");
}
var DEFAULT_CONFIG_DIR_NAME, PI_CODING_AGENT_PACKAGE_NAME, PI_CODING_AGENT_PACKAGE_ROOT_ENV, cachedConfigDirName;
var init_utils = __esm({
  "../../../../tmp/vrtbuild/src/shared/utils.ts"() {
    "use strict";
    init_display_text();
    init_formatters();
    init_lane_metadata();
    init_model_resolution();
    init_parallel_utils();
    DEFAULT_CONFIG_DIR_NAME = ".pi";
    PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
    PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
  }
});

// ../../../../tmp/vrtbuild/src/api/watchdog-runtime.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { open } from "node:fs/promises";
import { dirname as dirname11, resolve as resolve10 } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";

// ../../../../tmp/vrtbuild/src/shared/fork-context.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
function resolveSubagentContext(value) {
  return value === "fork" ? "fork" : "fresh";
}
function isUnsafeAnthropicThinkingBlock(message2, block, verbatim) {
  if (!message2 || !block || typeof block !== "object" || !("type" in block)) return false;
  if (verbatim) return block.type === "redacted_thinking";
  const provider = typeof message2.provider === "string" ? message2.provider.toLowerCase() : "";
  const api = typeof message2.api === "string" ? message2.api.toLowerCase() : "";
  const model2 = typeof message2.model === "string" ? message2.model.toLowerCase() : "";
  const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model2.startsWith("anthropic/");
  if (block.type === "redacted_thinking") return true;
  if (block.type !== "thinking" || !isAnthropic) return false;
  const record = block;
  const signature = "thinkingSignature" in record ? record.thinkingSignature : "signature" in record ? record.signature : void 0;
  return record.redacted === true || typeof signature === "string" && signature.length > 0;
}
function sanitizeUnsafeThinkingBlocks(entries, rewritten) {
  let sanitized = false;
  const entriesById = new Map(entries.flatMap((entry) => entry.id ? [[entry.id, entry]] : []));
  for (const entry of entries) {
    const targetMessage = entry.type === "context_edit" && entry.targetId ? entriesById.get(entry.targetId)?.message : entry.message;
    const contentOwner = entry.type === "context_edit" ? entry.replacement : targetMessage;
    if (targetMessage?.role !== "assistant" || !contentOwner || !Array.isArray(contentOwner.content)) continue;
    const verbatim = !rewritten && entry.type !== "context_edit";
    const filtered = contentOwner.content.filter((block) => !isUnsafeAnthropicThinkingBlock(targetMessage, block, verbatim));
    if (filtered.length === contentOwner.content.length) continue;
    contentOwner.content = filtered;
    sanitized = true;
  }
  return sanitized;
}
function readSessionEntries(sessionFile) {
  const lines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Unable to inspect forked session ${sessionFile}: invalid JSONL on line ${index + 1}: ${cause.message}`, { cause });
    }
  });
}
function createForkContextResolver(sessionManager, requestedContext, options) {
  if (resolveSubagentContext(requestedContext) !== "fork") {
    return {
      prepareSessionForIndex: async () => {
      },
      sessionFileForIndex: () => void 0
    };
  }
  const parentSessionFile = sessionManager.getSessionFile();
  if (!parentSessionFile) {
    throw new Error("Forked subagent context requires a persisted parent session.");
  }
  const leafId = sessionManager.getLeafId();
  if (!leafId) {
    throw new Error("Forked subagent context requires a current leaf to fork from.");
  }
  const openSession = options.openSession ?? sessionManager.openSession ?? ((file, dir) => SessionManager.open(file, dir));
  const forksDir = path.join(
    path.dirname(parentSessionFile),
    path.basename(parentSessionFile, ".jsonl"),
    "forks"
  );
  const cachedSessionFiles = /* @__PURE__ */ new Map();
  const preparedIndexes = /* @__PURE__ */ new Set();
  const preparationPromises = /* @__PURE__ */ new Map();
  const resolveFork = (index = 0) => {
    const cached = cachedSessionFiles.get(index);
    if (cached) return cached;
    try {
      if (!fs.existsSync(parentSessionFile)) {
        throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
      }
      const sessionDir = path.join(forksDir, options.runDirName());
      const sourceManager = openSession(parentSessionFile, sessionDir);
      const sessionFile = sourceManager.createBranchedSession(leafId);
      if (!sessionFile) {
        throw new Error("Session manager did not return a forked session file.");
      }
      if (!fs.existsSync(sessionFile)) {
        const header = sourceManager.getHeader?.();
        const entries = sourceManager.getEntries?.();
        if (!header || !entries) {
          throw new Error(`Session manager returned a forked session file that does not exist and cannot be persisted by fallback: ${sessionFile}`);
        }
        sanitizeUnsafeThinkingBlocks(entries, Boolean(options.pruneSession));
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}
`, "utf-8");
      } else {
        const entries = readSessionEntries(sessionFile);
        if (sanitizeUnsafeThinkingBlocks(entries, Boolean(options.pruneSession))) {
          fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}
`, "utf-8");
        }
      }
      cachedSessionFiles.set(index, sessionFile);
      return sessionFile;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
    }
  };
  return {
    async prepareSessionForIndex(index = 0) {
      const sessionFile = resolveFork(index);
      if (!options.pruneSession || preparedIndexes.has(index)) return;
      let preparation = preparationPromises.get(index);
      if (!preparation) {
        preparation = options.pruneSession(sessionFile).then(() => {
          preparedIndexes.add(index);
        });
        preparationPromises.set(index, preparation);
      }
      await preparation;
    },
    sessionFileForIndex(index = 0) {
      if (options.pruneSession && !preparedIndexes.has(index)) {
        throw new Error(`Pruned fork session ${index} was used before pruning completed.`);
      }
      return resolveFork(index);
    }
  };
}

// ../../../../tmp/vrtbuild/src/runs/shared/child-session.ts
import * as fs7 from "node:fs";

// ../../../../tmp/vrtbuild/src/runs/shared/child-commands.ts
import { randomUUID } from "node:crypto";
init_atomic_json();
import * as path8 from "node:path";
import { Type } from "typebox";

// ../../../../tmp/vrtbuild/src/runs/background/control-channel.ts
init_atomic_json();
init_types();
import * as fs6 from "node:fs";
import * as path7 from "node:path";

// ../../../../tmp/vrtbuild/src/shared/watch-strategy.ts
function shouldUseNativeFsWatch(_purpose, platform = process.platform) {
  if (_purpose === "retained-nested-route-tracker" && platform === "win32") return false;
  return platform !== "darwin";
}

// ../../../../tmp/vrtbuild/src/runs/background/control-channel.ts
init_utils();
var CONTROL_SAFETY_POLL_INTERVAL_MS = 5e3;
var REPEATED_SCAN_ERROR_SUMMARY_MS = 6e4;
function validCommandRequest(raw) {
  if (!raw || typeof raw !== "object") return false;
  const value = raw;
  return value.type === "command" && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.ownerId === "string" && /^[a-f0-9-]{36}$/.test(value.ownerId) && (value.operation === "status" || value.operation === "yield" || value.operation === "cancel") && Number.isSafeInteger(value.deadlineAt) && value.deadlineAt > 0 && (value.toolCallId === void 0 ? value.operation === "status" : typeof value.toolCallId === "string" && value.toolCallId.length > 0 && value.toolCallId.length <= 256);
}
function commandRequestsDir(dir) {
  return path7.join(controlInboxDir(dir), "command-requests");
}
function consumeCommandRequests(dir, fsImpl) {
  const requests = [];
  for (const name of fsImpl.readdirSync(commandRequestsDir(dir)).filter((entry) => entry.endsWith(".json")).sort()) {
    const file = path7.join(commandRequestsDir(dir), name);
    let value;
    try {
      value = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
    }
    try {
      fsImpl.rmSync(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (validCommandRequest(value)) requests.push(value);
  }
  return requests;
}
var STEER_REQUESTS_DIR = "steer-requests";
var STOP_REQUESTS_DIR = "stop-requests";
var MAX_STEER_MESSAGE_BYTES = 128 * 1024;
var MAX_STEER_REQUEST_ID_LENGTH = 256;
function controlInboxDir(asyncDir) {
  return path7.join(asyncDir, "control");
}
function interruptRequestPath(asyncDir) {
  return path7.join(controlInboxDir(asyncDir), "interrupt.json");
}
function timeoutRequestPath(asyncDir) {
  return path7.join(controlInboxDir(asyncDir), "timeout.json");
}
function stopRequestPath(asyncDir) {
  return path7.join(controlInboxDir(asyncDir), "stop.json");
}
function stopRequestsDir(asyncDir) {
  return path7.join(controlInboxDir(asyncDir), STOP_REQUESTS_DIR);
}
function steerRequestsDir(asyncDir) {
  return path7.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}
function validStopChildId(childId) {
  return typeof childId === "string" && Boolean(childId.trim()) && childId.length <= 256 && !/[\r\n]/.test(childId);
}
function validSteerRequest(request) {
  return request.type === "steer" && typeof request.id === "string" && /^[^\s]+$/.test(request.id) && request.id.length <= MAX_STEER_REQUEST_ID_LENGTH && typeof request.ts === "number" && Number.isFinite(request.ts) && request.ts > 0 && typeof request.message === "string" && Boolean(request.message.trim()) && Buffer.byteLength(request.message, "utf8") <= MAX_STEER_MESSAGE_BYTES && (request.mode === void 0 || request.mode === "steer" || request.mode === "follow_up" || request.mode === "auto") && (request.targetIndex === void 0 || Number.isInteger(request.targetIndex) && request.targetIndex >= 0 && request.targetIndex <= 1e6) && (request.targetIndexes === void 0 || request.targetIndex === void 0 && Array.isArray(request.targetIndexes) && request.targetIndexes.length > 0 && request.targetIndexes.length <= 1e3 && request.targetIndexes.every((index) => Number.isInteger(index) && index >= 0 && index <= 1e6) && new Set(request.targetIndexes).size === request.targetIndexes.length) && (request.source === void 0 || typeof request.source === "string" && Boolean(request.source.trim()) && request.source.length <= 256);
}
function parseSteerRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const input = raw;
  if (!validSteerRequest(input)) return void 0;
  return {
    type: "steer",
    id: input.id.trim(),
    ts: input.ts,
    message: input.message.trim(),
    ...input.mode ? { mode: input.mode } : {},
    ...input.targetIndex !== void 0 ? { targetIndex: input.targetIndex } : {},
    ...input.targetIndexes !== void 0 ? { targetIndexes: [...input.targetIndexes] } : {},
    ...typeof input.source === "string" && input.source.trim() ? { source: input.source } : {}
  };
}
function consumeSteerRequestsFromDir(dir, fsImpl = fs6, onError = () => {
}) {
  let entries;
  try {
    entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code !== "ENOENT") onError(error);
    return [];
  }
  const requests = [];
  for (const entry of entries) {
    const requestPath = path7.join(dir, entry);
    let parsed;
    let text2;
    try {
      text2 = fsImpl.readFileSync(requestPath, "utf-8");
    } catch (error) {
      if (error.code !== "ENOENT") onError(error);
      continue;
    }
    try {
      parsed = parseSteerRequest(JSON.parse(text2));
    } catch {
      parsed = void 0;
    }
    try {
      fsImpl.rmSync(requestPath, { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") onError(error);
      continue;
    }
    if (parsed) requests.push(parsed);
  }
  return requests.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}
function consumeInterruptRequest(asyncDir, fsImpl = fs6) {
  const requestPath = interruptRequestPath(asyncDir);
  if (!fsImpl.existsSync(requestPath)) return false;
  try {
    fsImpl.rmSync(requestPath, { force: true, recursive: true });
  } catch {
  }
  return true;
}
function consumeTimeoutRequest(asyncDir, fsImpl = fs6) {
  const requestPath = timeoutRequestPath(asyncDir);
  if (!fsImpl.existsSync(requestPath)) return false;
  try {
    fsImpl.rmSync(requestPath, { force: true, recursive: true });
  } catch {
  }
  return true;
}
function parseStopRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const parsed = raw;
  if (parsed.type !== "stop") return void 0;
  if (Object.hasOwn(parsed, "targetIndex") && !(Number.isInteger(parsed.targetIndex) && parsed.targetIndex >= 0 && parsed.targetIndex <= 1e6)) return void 0;
  if (Object.hasOwn(parsed, "childId") && !validStopChildId(parsed.childId)) return void 0;
  return {
    type: "stop",
    ...typeof parsed.ts === "number" ? { ts: parsed.ts } : {},
    ...typeof parsed.source === "string" ? { source: parsed.source } : {},
    ...typeof parsed.reason === "string" ? { reason: parsed.reason } : {},
    ...parsed.targetIndex !== void 0 ? { targetIndex: parsed.targetIndex } : {},
    ...validStopChildId(parsed.childId) ? { childId: parsed.childId } : {}
  };
}
function consumeStopRequestFile(requestPath, fsImpl, onError) {
  let text2;
  try {
    text2 = fsImpl.readFileSync(requestPath, "utf-8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) onError?.(error);
    return void 0;
  }
  let request;
  try {
    request = parseStopRequest(JSON.parse(text2));
  } catch {
    request = void 0;
  }
  try {
    fsImpl.rmSync(requestPath, { force: true, recursive: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) onError?.(error);
    return void 0;
  }
  return request;
}
function consumeStopRequestPayloads(asyncDir, fsImpl = fs6, onError) {
  const dir = stopRequestsDir(asyncDir);
  const requests = [];
  if (fsImpl.existsSync(dir)) {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) onError?.(error);
      entries = [];
    }
    for (const entry of entries) {
      const request = consumeStopRequestFile(path7.join(dir, entry), fsImpl, onError);
      if (request) requests.push(request);
    }
  }
  const legacyPath = stopRequestPath(asyncDir);
  if (fsImpl.existsSync(legacyPath)) {
    const request = consumeStopRequestFile(legacyPath, fsImpl, onError);
    if (request) requests.push(request);
  }
  return requests.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0));
}
function watchAsyncControlInbox(asyncDir, opts) {
  const fsImpl = opts.fs ?? fs6;
  const timers = opts.timers ?? { setInterval, clearInterval };
  const dir = controlInboxDir(asyncDir);
  const report = (error, phase, request) => {
    try {
      if (opts.onError) opts.onError(error, phase, request);
      else console.error(`Control inbox ${phase} failed:`, error);
    } catch (reportError) {
      console.error("Control inbox error reporter failed:", reportError);
    }
  };
  const repeatedScanErrors = /* @__PURE__ */ new Map();
  let scanFailed = false;
  const reportScan = (error) => {
    scanFailed = true;
    const text2 = error instanceof Error ? error.message : String(error);
    const now = (opts.now ?? Date.now)();
    const repeated = repeatedScanErrors.get(text2);
    if (!repeated) {
      repeatedScanErrors.set(text2, { suppressed: 0, since: now });
      report(error, "scan");
      return;
    }
    repeated.suppressed++;
    if (now - repeated.since < REPEATED_SCAN_ERROR_SUMMARY_MS) return;
    report(`${repeated.suppressed} more identical failures in the last ${Math.round((now - repeated.since) / 1e3)}s: ${text2}`, "scan");
    repeated.suppressed = 0;
    repeated.since = now;
  };
  const dirs = [
    ...opts.onInterrupt || opts.onTimeout || opts.onStop ? [dir] : [],
    ...opts.onStop ? [stopRequestsDir(asyncDir)] : [],
    ...opts.onSteer ? [steerRequestsDir(asyncDir)] : [],
    ...opts.onCommand ? [commandRequestsDir(asyncDir)] : []
  ];
  if (dirs.length === 0) return () => {
  };
  try {
    for (const target of dirs) fsImpl.mkdirSync(target, { recursive: true });
  } catch (error) {
    report(error, "install");
  }
  let disposed = false;
  const check = () => {
    if (disposed) return;
    scanFailed = false;
    try {
      if (opts.onCommand) for (const request of consumeCommandRequests(asyncDir, fsImpl)) {
        try {
          opts.onCommand(request);
        } catch (error) {
          report(error, "callback");
        }
      }
      if (opts.onStop) for (const request of consumeStopRequestPayloads(asyncDir, fsImpl, reportScan)) {
        try {
          opts.onStop(request);
        } catch (error) {
          report(error, "callback");
        }
      }
      if (opts.onTimeout && consumeTimeoutRequest(asyncDir, fsImpl)) {
        try {
          opts.onTimeout();
        } catch (error) {
          report(error, "callback");
        }
      }
      if (opts.onInterrupt && consumeInterruptRequest(asyncDir, fsImpl)) {
        try {
          opts.onInterrupt();
        } catch (error) {
          report(error, "callback");
        }
      }
      if (opts.onSteer) for (const request of consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl, reportScan)) {
        try {
          opts.onSteer(request);
        } catch (error) {
          report(error, "callback", request);
        }
      }
    } catch (error) {
      reportScan(error);
    }
    if (!scanFailed) repeatedScanErrors.clear();
  };
  check();
  const watchers = [];
  let interval;
  let safetyInterval;
  const startPolling = () => {
    if (interval || disposed) return;
    if (safetyInterval) {
      timers.clearInterval(safetyInterval);
      safetyInterval = void 0;
    }
    interval = timers.setInterval(check, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
    interval.unref?.();
  };
  try {
    if (shouldUseNativeFsWatch("runner-control-inbox", opts.platform)) {
      for (const target of dirs) {
        const watcher = fsImpl.watch(resolveWatchPath(target, fsImpl.realpathSync.native), check);
        watcher.on?.("error", startPolling);
        watchers.push(watcher);
      }
      if (!interval) {
        safetyInterval = timers.setInterval(check, opts.safetyPollIntervalMs ?? CONTROL_SAFETY_POLL_INTERVAL_MS);
        safetyInterval.unref?.();
      }
    } else {
      startPolling();
    }
  } catch {
    startPolling();
  }
  return () => {
    if (disposed) return;
    disposed = true;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
      }
    }
    if (interval) timers.clearInterval(interval);
    if (safetyInterval) timers.clearInterval(safetyInterval);
  };
}

// ../../../../tmp/vrtbuild/src/runs/shared/child-commands.ts
var CHILD_COMMAND_TOOL = "subagent_command";
var writeAtomicJson2 = createAtomicJsonWriter({ mode: 384 });
var MAX_OUTPUT_BYTES = 8 * 1024;
var RECENT_COMMANDS = 20;
function childCommandStatePath(channelDir) {
  return path8.join(channelDir, "commands.json");
}
function active(job) {
  return job.snapshot.endedAt === void 0;
}
function text(result) {
  return Buffer.from(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).subarray(-MAX_OUTPUT_BYTES).toString("utf8");
}
function createChildCommandRuntime(channelDir) {
  const ownerId = randomUUID();
  const jobs = /* @__PURE__ */ new Map();
  const usedIds = /* @__PURE__ */ new Set();
  let closed = false;
  let disposeInbox;
  const state = () => ({ ownerId, closed, commands: [...jobs.values()].map((job) => ({ ...job.snapshot })) });
  const persist = () => writeAtomicJson2(childCommandStatePath(channelDir), {
    ownerId,
    closed,
    commands: [...jobs.values()].map((job) => ({ ...job.snapshot, output: job.yielded ? job.snapshot.output : "" }))
  });
  const operate = (operation, toolCallId) => {
    if (operation === "status" && toolCallId === void 0) return state();
    const job = toolCallId ? jobs.get(toolCallId) : void 0;
    if (!job) throw new Error(`No retained command '${toolCallId ?? ""}' in this child session.`);
    if (operation !== "status" && closed) throw new Error("Child command controller is closed.");
    const before = job.snapshot.state;
    if (active(job)) {
      if (operation === "yield" && job.snapshot.state === "running") {
        job.yielded = true;
        job.snapshot.state = "yielded";
        job.yieldResult();
      } else if (operation === "cancel") {
        job.snapshot.state = "cancel_requested";
        job.controller.abort();
      }
    }
    if (job.snapshot.state !== before) persist();
    return { ownerId, closed, commands: [{ ...job.snapshot }] };
  };
  const startInbox = () => {
    if (disposeInbox) return;
    disposeInbox = watchAsyncControlInbox(channelDir, {
      onCommand(request) {
        const replyPath = commandReplyPath(channelDir, request.id);
        try {
          if (request.ownerId !== ownerId) throw new Error("Command request belongs to another child session.");
          if (Date.now() > request.deadlineAt) throw new Error("Command request expired before delivery.");
          writeAtomicJson2(replyPath, { state: operate(request.operation, request.toolCallId) });
        } catch (error) {
          writeAtomicJson2(replyPath, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  };
  const stop = async () => {
    closed = true;
    disposeInbox?.();
    for (const job of jobs.values()) if (active(job)) {
      job.snapshot.state = "cancel_requested";
      job.controller.abort();
    }
    await Promise.all([...jobs.values()].map((job) => job.settled));
    if (jobs.size) persist();
  };
  return {
    state,
    operate,
    shutdown: stop,
    async finish() {
      const pending = [...jobs.values()].filter(active);
      if (!pending.length) return;
      await stop();
      throw new Error(`Child finished with unfinished commands: ${pending.map((job) => job.snapshot.toolCallId).join(", ")}. Commands were cancelled; query or cancel background commands before finishing.`);
    },
    wrap(tool) {
      return {
        ...tool,
        parameters: Type.Unsafe({ ...tool.parameters, properties: {
          ...tool.parameters.properties,
          yieldTimeMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3e4, description: "Return a managed command handle after this wait; does not terminate the command. Omit to wait for completion." }))
        } }),
        description: `${tool.description}
Optional yieldTimeMs returns a command handle without stopping execution. Use subagent_command to query or cancel it. Finish or cancel every command before completing the task.`,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          if (closed) throw new Error("Child command controller is closed.");
          if (usedIds.has(toolCallId)) throw new Error(`Command id '${toolCallId}' was already used in this child session.`);
          usedIds.add(toolCallId);
          const { yieldTimeMs, ...args2 } = params;
          const controller = new AbortController();
          const commandSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          let yieldResult;
          const yielded = new Promise((resolve11) => {
            yieldResult = resolve11;
          });
          const job = { snapshot: { toolCallId, state: "running", startedAt: Date.now(), output: "" }, controller, yieldResult, settled: Promise.resolve() };
          const completed = [...jobs].filter(([, candidate]) => !active(candidate));
          for (const [id2] of completed.slice(0, Math.max(0, completed.length - RECENT_COMMANDS + 1))) jobs.delete(id2);
          jobs.set(toolCallId, job);
          persist();
          startInbox();
          let timer;
          if (typeof yieldTimeMs === "number") timer = setTimeout(() => operate("yield", toolCallId), yieldTimeMs);
          const execution = Promise.resolve().then(() => tool.execute(toolCallId, args2, commandSignal, (update) => {
            job.snapshot.output = text(update);
            if (job.snapshot.state === "running") onUpdate?.(update);
          }, ctx)).then((result2) => {
            job.snapshot.output = text(result2);
            job.snapshot.state = "completed";
            const fullOutputPath = result2.details?.fullOutputPath;
            if (fullOutputPath) job.snapshot.fullOutputPath = fullOutputPath;
            return result2;
          }, (error) => {
            job.snapshot.state = controller.signal.aborted ? "cancelled" : "failed";
            job.snapshot.output = String(error).slice(-MAX_OUTPUT_BYTES);
            throw error;
          }).finally(() => {
            if (timer) clearTimeout(timer);
            job.snapshot.endedAt = Date.now();
            persist();
          });
          job.settled = execution.then(() => {
          }, () => {
          });
          const result = await Promise.race([execution.then((value) => ({ value })), yielded.then(() => void 0)]);
          if (result) return result.value;
          return { content: [{ type: "text", text: `Command is still running (toolCallId: ${toolCallId}). This is not a successful exit. Use subagent_command({ action: "status", toolCallId: ${JSON.stringify(toolCallId)} }) to inspect or wait, or action: "cancel" to stop it.
${job.snapshot.output}` }], details: { command: { ...job.snapshot } } };
        }
      };
    },
    tool() {
      return {
        name: CHILD_COMMAND_TOOL,
        label: "Child command",
        description: "Inspect or cancel bash commands owned by this child. Cancellation stops only the selected command, not the agent. Check terminal state before finishing.",
        parameters: Type.Object({ action: Type.String({ enum: ["status", "cancel"] }), toolCallId: Type.Optional(Type.String()), waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3e4 })) }),
        async execute(_id, params, signal) {
          const { action: action2, toolCallId, waitMs = 0 } = params;
          operate(action2, toolCallId);
          const job = toolCallId ? jobs.get(toolCallId) : void 0;
          if (job && active(job) && waitMs > 0) await waitForCommand(job.settled, waitMs, signal);
          const snapshot = operate("status", toolCallId);
          return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
        }
      };
    }
  };
}
async function waitForCommand(settled, waitMs, signal) {
  let timer;
  let abort;
  const wait = new Promise((resolve11, reject) => {
    timer = setTimeout(resolve11, waitMs);
    abort = () => reject(new Error("Command wait aborted; command remains managed by the child."));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([settled, wait]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
function commandReplyPath(channelDir, id2) {
  return path8.join(channelDir, "command-replies", `${id2}.json`);
}

// ../../../../tmp/vrtbuild/src/runs/shared/child-tool-plan.ts
import { createHash as createHash2 } from "node:crypto";
import * as path10 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// ../../../../tmp/vrtbuild/src/runs/shared/mcp-direct-tool-allowlist.ts
init_agents();
init_utils();
import * as os3 from "node:os";
import * as path9 from "node:path";

// ../../../../tmp/vrtbuild/src/runs/shared/mcp-config-sources.ts
init_agents();
init_utils();

// ../../../../tmp/vrtbuild/src/runs/shared/mcp-direct-tool-allowlist.ts
var CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var GENERIC_GLOBAL_CONFIG_PATH = path9.join(os3.homedir(), ".config", "mcp", "mcp.json");
var IMPORT_PATHS = {
  cursor: [path9.join(os3.homedir(), ".cursor", "mcp.json")],
  "claude-code": [
    path9.join(os3.homedir(), ".claude", "mcp.json"),
    path9.join(os3.homedir(), ".claude.json"),
    path9.join(os3.homedir(), ".claude", "claude_desktop_config.json")
  ],
  "claude-desktop": [path9.join(os3.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
  codex: [path9.join(os3.homedir(), ".codex", "config.json")],
  windsurf: [path9.join(os3.homedir(), ".windsurf", "mcp.json")],
  vscode: [".vscode/mcp.json"]
};

// ../../../../tmp/vrtbuild/src/runs/shared/child-tool-plan.ts
init_types();
init_model_info();
init_utils();

// ../../../../tmp/vrtbuild/src/shared/runtime-module-path.ts
var RUNTIME_MODULE_EXTENSIONS = [".js", ".ts"];

// ../../../../tmp/vrtbuild/src/shared/required-child-extensions.ts
var EMPTY_SNAPSHOT = Object.freeze([]);

// ../../../../tmp/vrtbuild/src/runs/shared/child-tool-plan.ts
init_capability_ceiling();
var RUNTIME_EXTENSION_DIR = path10.dirname(fileURLToPath2(import.meta.url));
var FANOUT_CHILD_EXTENSION_DIR = path10.join(RUNTIME_EXTENSION_DIR, "..", "..", "extension");
var SUBAGENT_RUNTIME_EXTENSION_PATHS = new Set([
  path10.join(RUNTIME_EXTENSION_DIR, "subagent-prompt-runtime"),
  path10.join(RUNTIME_EXTENSION_DIR, "fast-mode-extension"),
  path10.join(FANOUT_CHILD_EXTENSION_DIR, "fanout-child")
].flatMap((base) => RUNTIME_MODULE_EXTENSIONS.map((extension) => path10.normalize(`${base}${extension}`))));
var OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function deriveForkPromptCacheKey(parentSessionId) {
  const parent = parentSessionId?.trim();
  if (!parent) return void 0;
  const digest = createHash2("sha256").update(parent).digest("hex").slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - "pi-fork:".length);
  return `pi-fork:${digest}`;
}
function sanitizeSupervisorChannelSegment(value) {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}
function supervisorChannelDir(runId, agent2, childIndex) {
  return path10.join(
    TEMP_ROOT_DIR,
    "supervisor-channels",
    `${sanitizeSupervisorChannelSegment(runId)}-${sanitizeSupervisorChannelSegment(agent2)}-${childIndex}`
  );
}

// ../../../../tmp/vrtbuild/src/shared/child-cache-retention.ts
function childCacheRetention(env = process.env) {
  return env.PI_SUBAGENT_CACHE_RETENTION || void 0;
}
function pinChildCacheRetention(agent2, env) {
  if (!agent2?.streamFunction) return;
  const retention = childCacheRetention(env);
  if (!retention) return;
  const base = agent2.streamFunction;
  agent2.streamFunction = (model2, context, options) => base(model2, context, {
    ...options,
    env: { ...options?.env ?? {}, PI_CACHE_RETENTION: retention }
  });
}

// ../../../../tmp/vrtbuild/src/runs/shared/child-session.ts
init_utils();
init_pi_spawn();
function applyChildRetryPolicy(session, policy) {
  session.setAutoRetryEnabled(policy === "native");
}
function inheritParentProviders(modelRuntime, parentProviders, claimedProviderIds, onError) {
  let providerIds;
  try {
    providerIds = parentProviders.getRegisteredProviderIds();
  } catch (error) {
    onError?.({ extensionPath: "<parent-providers>", event: "inherit_provider", error });
    throw new Error(`Failed to enumerate parent providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const inherited = /* @__PURE__ */ new Set();
  for (const providerId of new Set(providerIds)) {
    if (claimedProviderIds.has(providerId)) continue;
    try {
      const native = parentProviders.getRegisteredNativeProvider(providerId);
      const config = native ? void 0 : parentProviders.getRegisteredProviderConfig(providerId);
      if (native) modelRuntime.registerNativeProvider(native);
      else if (config) modelRuntime.registerProvider(providerId, config);
      else throw new Error(`Parent provider '${providerId}' has no registered native provider or config.`);
      inherited.add(providerId);
    } catch (error) {
      onError?.({ extensionPath: `<parent-provider:${providerId}>`, event: "inherit_provider", error });
      throw new Error(`Failed to inherit parent provider '${providerId}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return inherited;
}
var CHILD_PROMPT_RUNTIME_EXTENSION_PATH = "<inline:pi-subagents:prompt-runtime>";
var CHILD_PROMPT_BOUNDARY_EXTENSION_PATH = "<inline:pi-subagents:prompt-boundary>";
function orderChildPromptHooks(result) {
  const runtime = result.extensions.filter(({ path: path16 }) => path16 === CHILD_PROMPT_RUNTIME_EXTENSION_PATH);
  const boundary = result.extensions.filter(({ path: path16 }) => path16 === CHILD_PROMPT_BOUNDARY_EXTENSION_PATH);
  const others = result.extensions.filter(({ path: path16 }) => path16 !== CHILD_PROMPT_RUNTIME_EXTENSION_PATH && path16 !== CHILD_PROMPT_BOUNDARY_EXTENSION_PATH);
  return { ...result, extensions: [...runtime, ...others, ...boundary] };
}
function prioritizeChildCommandRuntime(result) {
  const index = result.extensions.findIndex(({ path: path16 }) => path16 === "<inline:pi-subagents:commands>");
  if (index < 0) return result;
  if (result.extensions.some((extension, otherIndex) => otherIndex !== index && extension.tools?.has("bash"))) {
    const extensions2 = result.extensions.filter((_, otherIndex) => otherIndex !== index);
    if (!extensions2.some((extension) => extension.tools?.has(CHILD_COMMAND_TOOL))) {
      const commands2 = result.extensions[index];
      const registered = commands2.tools.get(CHILD_COMMAND_TOOL);
      const reason = "Native command controls are unavailable with the active custom bash backend. Use that backend's own command controls.";
      extensions2.push({ ...commands2, tools: /* @__PURE__ */ new Map([[CHILD_COMMAND_TOOL, { ...registered, definition: {
        ...registered.definition,
        description: reason,
        execute: async () => {
          throw new Error(reason);
        }
      } }]]) });
    }
    return { ...result, extensions: extensions2 };
  }
  if (index === 0) return result;
  const extensions = [...result.extensions];
  const [commands] = extensions.splice(index, 1);
  extensions.unshift(commands);
  return { ...result, extensions };
}
var loading = Promise.resolve();
function resetExtensionCacheOnReload(loader) {
  if (!("loaded" in loader)) return false;
  loader.loaded = true;
  return true;
}
function applyProcessEnv(values) {
  if (!values) return;
  for (const [name, value] of Object.entries(values)) {
    if (value === void 0) delete process.env[name];
    else process.env[name] = value;
  }
}
function selectedBuiltinMcpExtension(pi, selections, readinessTool) {
  const createMcpExtension = pi.createMcpExtension;
  if (typeof createMcpExtension !== "function") throw new Error(`Selected built-in MCP tools (${selections.map(({ name }) => name).join(", ")}) need a Pi version with built-in MCP.`);
  const selectors = new Map(selections.map(({ name, selector }) => [name, selector]));
  const split = (value) => {
    const slash = value.indexOf("/");
    return { server: (slash === -1 ? value : value.slice(0, slash)).replace(/-/g, "_"), tool: slash === -1 ? void 0 : value.slice(slash + 1) };
  };
  const granted = (tool) => {
    const selector = selectors.get(tool.name);
    if (selector === void 0 || tool.exposure === "hidden" || tool.label === void 0) return false;
    const want = split(selector);
    const have = split(tool.label);
    return have.tool !== void 0 && have.server === want.server && (want.tool === void 0 || want.tool === have.tool);
  };
  const mcp = createMcpExtension();
  let waitForTools;
  let checkingStartup = false;
  const factory = async (api) => {
    const toolCallHandlers = [];
    await mcp(new Proxy(api, {
      get(target, prop) {
        if (prop === "getAllTools") return () => checkingStartup && readinessTool() ? [readinessTool()] : target.getAllTools();
        if (prop === "registerTool") {
          return (tool) => target.registerTool({ ...tool, exposure: granted(tool) ? "direct" : "hidden" });
        }
        if (prop === "on") {
          return (event, handler) => {
            if (event === "tool_call") toolCallHandlers.push(handler);
            return target.on(event, handler);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }));
    api.on("session_start", (_event, ctx) => {
      waitForTools = async (signal) => {
        if (toolCallHandlers.length === 0) throw new Error(`Selected built-in MCP tools (${selections.map(({ name }) => name).join(", ")}) need Pi 0.99.2 or later; earlier built-in MCP cannot report when its servers have connected.`);
        const event = { type: "tool_call", toolCallId: "pi-subagents:mcp-startup", toolName: "codemode", input: { code: selections.map(({ name }) => `tools.${name}`).join(";\n") } };
        const context = new Proxy(ctx, { get: (target, prop, receiver) => prop === "signal" ? signal : Reflect.get(target, prop, receiver) });
        checkingStartup = true;
        try {
          for (const handler of toolCallHandlers) {
            if (signal.aborted) return;
            const result = await handler(event, context);
            if (result?.block) throw new Error(result.reason ?? "MCP startup readiness was blocked.");
          }
        } finally {
          checkingStartup = false;
        }
      };
    });
  };
  return { name: "mcp", factory, builtin: true, replaceable: true, async waitForTools(signal, loadError) {
    if (!waitForTools) {
      const error = loadError();
      throw new Error(`Pi's built-in MCP readiness hook did not start in the child session${error ? `: ${error}` : "."}`);
    }
    await waitForTools(signal);
  } };
}
function missingBuiltinMcpTools(session, names) {
  const active2 = new Set(session.getActiveToolNames());
  const direct = new Set(session.getAllTools().filter((tool) => tool.exposure === "direct").map(({ name }) => name));
  return names.filter((name) => !active2.has(name) || !direct.has(name));
}
function flushQueuedProviderRegistrations(loader, modelRuntime, onError, requiredPaths) {
  const claimedProviderIds = /* @__PURE__ */ new Set();
  if (!("getExtensions" in loader) || typeof loader.getExtensions !== "function") return { claimedProviderIds, registered: false };
  const { runtime } = loader.getExtensions();
  let registered = false;
  for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations ?? []) {
    claimedProviderIds.add(name);
    try {
      modelRuntime.registerProvider(name, config);
      registered = true;
    } catch (error) {
      onError?.({ extensionPath, event: "register_provider", error });
      if (requiredPaths.has(extensionPath)) throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (Array.isArray(runtime.pendingProviderRegistrations)) runtime.pendingProviderRegistrations = [];
  for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations ?? []) {
    claimedProviderIds.add(provider.id);
    try {
      modelRuntime.registerNativeProvider(provider);
      registered = true;
    } catch (error) {
      onError?.({ extensionPath, event: "register_provider", error });
      if (requiredPaths.has(extensionPath)) throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (Array.isArray(runtime.pendingNativeProviderRegistrations)) runtime.pendingNativeProviderRegistrations = [];
  const virtualModelRuntime = modelRuntime;
  const virtualModelQueue = runtime;
  const pendingVirtualModelRegistrations = virtualModelQueue.pendingVirtualModelRegistrations ?? [];
  for (const { definition, extensionPath } of pendingVirtualModelRegistrations) {
    if (typeof virtualModelRuntime.registerVirtualModel !== "function") break;
    try {
      virtualModelRuntime.registerVirtualModel(definition);
      registered = true;
    } catch (error) {
      onError?.({ extensionPath, event: "register_virtual_model", error });
      if (requiredPaths.has(extensionPath)) throw new Error(`Required child extension virtual model registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (Array.isArray(virtualModelQueue.pendingVirtualModelRegistrations)) virtualModelQueue.pendingVirtualModelRegistrations = [];
  return { claimedProviderIds, registered };
}
async function loadHostPiCodingAgent() {
  throw new Error("The vendored watchdog runtime requires an injected host Pi SDK.");
}
function createDefaultChildSessionFactory(options = {}) {
  const loadPiCodingAgent = options.loadPiCodingAgent ?? loadHostPiCodingAgent;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5e3;
  let runtime;
  const live = /* @__PURE__ */ new Set();
  const shutdowns = /* @__PURE__ */ new Set();
  const mcpWaits = /* @__PURE__ */ new Map();
  let disposals = 0;
  const sharedRuntime = async (pi) => {
    runtime ??= pi.ModelRuntime.create().catch((error) => {
      runtime = void 0;
      throw error;
    });
    return runtime;
  };
  return {
    async create(launch) {
      const disposalsAtStart = disposals;
      const pi = await loadPiCodingAgent();
      const builtinMcpTools = launch.builtinMcpTools ?? [];
      let readinessTool;
      const builtinMcp = builtinMcpTools.length ? selectedBuiltinMcpExtension(pi, builtinMcpTools, () => readinessTool) : void 0;
      const modelRuntime = launch.parentProviderRegistry ? await pi.ModelRuntime.create() : await sharedRuntime(pi);
      const agentDir = launch.agentDir ?? getAgentDir();
      const commands = launch.runtime.runId && launch.runtime.agent && launch.runtime.childIndex !== void 0 && launch.tools?.includes("bash") && launch.tools.includes(CHILD_COMMAND_TOOL) && !launch.excludeTools?.includes("bash") && !launch.excludeTools?.includes(CHILD_COMMAND_TOOL) && typeof pi.createBashTool === "function" ? createChildCommandRuntime(supervisorChannelDir(launch.runtime.runId, launch.runtime.agent, launch.runtime.childIndex)) : void 0;
      const settingsManager = pi.SettingsManager.create(launch.cwd, agentDir, { projectTrusted: launch.projectTrusted });
      const themeKey = /* @__PURE__ */ Symbol.for("@earendil-works/pi-coding-agent:theme");
      const themeInitialized = Boolean(globalThis[themeKey]);
      if (!themeInitialized && typeof pi.initTheme === "function") pi.initTheme(settingsManager.getTheme());
      const createCodemodeExtension = pi.createCodemodeExtension;
      const codemodeAllowed = !launch.runtime.capabilityCeiling?.denyExtensions && (launch.tools === void 0 || launch.tools.includes("codemode")) && !launch.excludeTools?.includes("codemode");
      const codemode = typeof createCodemodeExtension === "function" && (codemodeAllowed || builtinMcp) ? [{ name: "codemode", replaceable: true, factory: (api) => createCodemodeExtension()(new Proxy(api, {
        get(target, prop) {
          if (prop === "registerTool") return (tool) => {
            if (tool.name === "codemode") readinessTool = tool;
            target.registerTool(codemodeAllowed ? tool : { ...tool, exposure: "hidden" });
          };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      })) }] : [];
      const loader = new pi.DefaultResourceLoader({
        cwd: launch.cwd,
        agentDir,
        settingsManager,
        noExtensions: !launch.ambientExtensions,
        noSkills: launch.noSkills,
        // Pi merges skills from extensions' resources_discover without checking noSkills.
        skillsOverride: launch.noSkills ? (base) => ({ ...base, skills: [] }) : void 0,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: launch.noContextFiles,
        additionalExtensionPaths: builtinMcp ? [...launch.extensionPaths, "builtin:mcp"] : launch.extensionPaths,
        extensionFactories: [...launch.hooks, ...commands ? [{ name: "pi-subagents:commands", factory: (api) => {
          api.registerTool(commands.wrap(pi.createBashTool(launch.cwd, { commandPrefix: settingsManager.getShellCommandPrefix(), shellPath: settingsManager.getShellPath() })));
          api.registerTool(commands.tool());
        } }] : [], ...codemode, ...builtinMcp ? [builtinMcp] : []],
        extensionsOverride: (result) => orderChildPromptHooks(prioritizeChildCommandRuntime(result)),
        ...launch.systemPrompt !== void 0 ? { systemPrompt: launch.systemPrompt } : {},
        ...launch.appendSystemPrompt !== void 0 ? { appendSystemPrompt: [launch.appendSystemPrompt] } : {}
      });
      const shutdownSession = async (session2) => {
        try {
          await commands?.shutdown();
          const runner = session2.extensionRunner;
          if (runner.hasHandlers("session_shutdown")) {
            await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise((resolve11) => setTimeout(resolve11, shutdownTimeoutMs).unref?.())]);
          }
        } catch (error) {
          launch.onExtensionError?.({ extensionPath: "<session>", event: "session_shutdown", error });
        } finally {
          session2.dispose();
        }
      };
      let inheritedProviders = /* @__PURE__ */ new Set();
      const open2 = async () => {
        const requiredPaths = new Set((launch.requiredExtensions ?? []).map(({ path: path16 }) => path16));
        applyProcessEnv(launch.processEnv);
        if (!resetExtensionCacheOnReload(loader) && (launch.ambientExtensions || launch.extensionPaths.length)) launch.onExtensionError?.({ extensionPath: "<loader>", event: "load", error: new Error("pi's extension cache reset is unavailable; extensions loaded into this child share module state with other sessions in this process.") });
        await loader.reload();
        const loadErrors = requiredPaths.size > 0 ? loader.getExtensions().errors.filter(({ path: path16 }) => requiredPaths.has(path16)) : [];
        if (loadErrors.length > 0) throw new Error(`Required child extension failed to load: ${loadErrors.map(({ path: path16, error }) => `${path16}: ${error}`).join("; ")}`);
        const queued = flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError, requiredPaths);
        if (launch.parentProviderRegistry) inheritedProviders = inheritParentProviders(modelRuntime, launch.parentProviderRegistry, queued.claimedProviderIds, launch.onExtensionError);
        if (queued.registered || inheritedProviders.size > 0) {
          try {
            await modelRuntime.refresh({ allowNetwork: false });
          } catch (error) {
            launch.onExtensionError?.({ extensionPath: "<provider-refresh>", event: "refresh_providers", error });
            throw new Error(`Failed to refresh child providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
        const newSessionOptions = launch.parentSessionFile ? { parentSession: launch.parentSessionFile } : void 0;
        const newSessionFile = launch.storage.kind === "file" && !fs7.existsSync(launch.storage.sessionFile);
        const sessionManager = launch.storage.kind === "file" ? pi.SessionManager.open(launch.storage.sessionFile, void 0, launch.cwd) : launch.storage.kind === "dir" ? pi.SessionManager.create(launch.cwd, launch.storage.sessionDir, newSessionOptions) : launch.storage.kind === "memory" ? pi.SessionManager.inMemory(launch.cwd, newSessionOptions) : pi.SessionManager.create(launch.cwd, void 0, newSessionOptions);
        const header = newSessionFile && launch.parentSessionFile ? sessionManager.getHeader() : null;
        if (header) header.parentSession = launch.parentSessionFile;
        const resolvedModel = launch.model ? pi.resolveCliModel({ cliModel: launch.model, modelRuntime }) : void 0;
        if (resolvedModel?.error) throw new Error(resolvedModel.error);
        const { session: session2 } = await pi.createAgentSession({
          cwd: launch.cwd,
          agentDir,
          modelRuntime,
          ...resolvedModel?.model ? { model: resolvedModel.model } : {},
          ...resolvedModel?.thinkingLevel ? { thinkingLevel: resolvedModel.thinkingLevel } : {},
          ...launch.tools ? { tools: launch.tools } : {},
          ...launch.excludeTools?.length ? { excludeTools: launch.excludeTools } : {},
          resourceLoader: loader,
          sessionManager,
          settingsManager,
          sessionStartEvent: { type: "session_start", reason: "startup" }
        });
        pinChildCacheRetention(session2.agent);
        session2.setAutoCompactionEnabled(false);
        applyChildRetryPolicy(session2, launch.autoRetryPolicy);
        const requiredStartupErrors = [];
        let binding = true;
        try {
          await session2.bindExtensions({
            mode: "print",
            onError: (error) => {
              if (binding && requiredPaths.has(error.extensionPath)) requiredStartupErrors.push(`${error.extensionPath} (${error.event}): ${error.error}`);
              launch.onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error });
            }
          });
        } catch (error) {
          session2.dispose();
          throw error;
        } finally {
          binding = false;
        }
        if (requiredStartupErrors.length > 0) {
          await shutdownSession(session2);
          throw new Error(`Required child extension failed during startup: ${requiredStartupErrors.join("; ")}`);
        }
        return session2;
      };
      const opened = loading.catch(() => {
      }).then(open2);
      loading = opened;
      const session = await opened;
      let pending;
      const shutdown = () => shutdownSession(session);
      if (builtinMcp) {
        const cancel = new AbortController();
        const signal = launch.signal ? AbortSignal.any([cancel.signal, launch.signal]) : cancel.signal;
        if (disposals !== disposalsAtStart) cancel.abort();
        const ready = (async () => {
          try {
            await builtinMcp.waitForTools(signal, () => loader.getExtensions().errors.find(({ path: path16 }) => path16 === "builtin:mcp")?.error);
            if (disposals !== disposalsAtStart) throw new Error("The child session factory was disposed while the child waited for its MCP tools.");
            if (signal.aborted) throw new Error("The child launch was cancelled while waiting for its MCP tools.");
            const missing = missingBuiltinMcpTools(session, builtinMcpTools.map(({ name }) => name));
            if (missing.length) throw new Error(`Selected built-in MCP tools did not register in the child session: ${missing.join(", ")}. The MCP server may have failed to connect, or the name belongs to a different tool than the selector names; check it with /mcp.`);
          } catch (error) {
            await shutdown();
            throw error;
          }
        })();
        mcpWaits.set(cancel, ready);
        try {
          await ready;
        } finally {
          mcpWaits.delete(cancel);
        }
      }
      const child = {
        subscribe: (listener) => session.subscribe((event) => listener(event)),
        prompt: (text2) => session.prompt(text2),
        ...commands ? { finishCommands: () => commands.finish() } : {},
        steer: (text2) => session.steer(text2),
        followUp: (text2) => session.followUp(text2),
        abort: () => session.abort(),
        hasQueuedMessages: () => session.agent?.hasQueuedMessages?.() === true,
        dispose: () => {
          if (!pending) {
            live.delete(child);
            const shutdownDone = shutdown();
            pending = shutdownDone;
            shutdowns.add(shutdownDone);
            void shutdownDone.finally(() => shutdowns.delete(shutdownDone));
          }
          return pending;
        },
        get messages() {
          return session.messages;
        },
        get sessionFile() {
          return session.sessionFile;
        },
        get sessionId() {
          return session.sessionId;
        },
        get modelId() {
          return session.model ? `${session.model.provider}/${session.model.id}` : void 0;
        },
        get inheritedProvider() {
          return session.model && inheritedProviders.has(session.model.provider) ? session.model.provider : void 0;
        },
        get virtualModelId() {
          return session.model?.api === "pi-virtual" ? `${session.model.provider}/${session.model.id}` : void 0;
        },
        get contextWindow() {
          return session.model?.contextWindow;
        }
      };
      live.add(child);
      return child;
    },
    async dispose() {
      disposals += 1;
      for (const cancel of mcpWaits.keys()) cancel.abort();
      const children = [...live].filter((child) => !child.detached);
      for (const child of children) child.shutDown = true;
      await Promise.allSettled(children.map((child) => child.abort()));
      for (const child of children) {
        try {
          void child.dispose();
        } catch {
        }
      }
      await Promise.allSettled([...shutdowns, ...mcpWaits.values()]);
      if (live.size === 0) runtime = void 0;
    }
  };
}

// ../../../../tmp/vrtbuild/src/runs/shared/subagent-prompt-runtime.ts
import { declarationsEqual as declarationsEqual2, getCurrentSystemMessage as getCurrentSystemMessage2, getCurrentTools } from "@earendil-works/pi-ai";

// ../../../../tmp/vrtbuild/src/intercom/native-supervisor-channel.ts
init_types();
init_utils();
import * as path11 from "node:path";
import { Type as Type2 } from "typebox";
init_atomic_json();

// ../../../../tmp/vrtbuild/src/shared/extension-context.ts
var MODEL_ONLY_TOOL = { exposure: "model-only" };

// ../../../../tmp/vrtbuild/src/intercom/native-supervisor-channel.ts
var SUPERVISOR_CHANNEL_ROOT = path11.join(TEMP_ROOT_DIR, "supervisor-channels");
var MAX_MESSAGE_BYTES = 64 * 1024;
var DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1e3;
var CHANNEL_POLL_MS = Math.min(POLL_INTERVAL_MS, 500);
var STALE_EMPTY_CHANNEL_AGE_MS = 60 * 1e3;
var STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS = 60 * 1e3;
var SUPERVISOR_REQUEST_CORRELATION_RETENTION_MS = 10 * 60 * 1e3;
var ContactSupervisorParamsSchema = Type2.Object({
  reason: Type2.String({ enum: ["need_decision", "interview_request", "progress_update"] }),
  message: Type2.Optional(Type2.String()),
  interview: Type2.Optional(Type2.Unsafe({ type: "object", additionalProperties: true }))
}, { additionalProperties: false });
var IntercomParamsSchema = Type2.Object({
  action: Type2.String({ enum: ["list", "pending", "status", "reply"] }),
  to: Type2.Optional(Type2.String()),
  message: Type2.Optional(Type2.String()),
  replyTo: Type2.Optional(Type2.String())
}, { additionalProperties: false });
var CONTACT_SUPERVISOR_TOOL_NAME = "contact_supervisor";
var CONTACT_SUPERVISOR_DECLARATION = {
  name: CONTACT_SUPERVISOR_TOOL_NAME,
  ...MODEL_ONLY_TOOL,
  label: "Contact Supervisor",
  description: "Contact the parent/supervisor session for a blocking decision, structured interview, or progress update.",
  parameters: ContactSupervisorParamsSchema
};

// ../../../../tmp/vrtbuild/src/runs/shared/subagent-prompt-runtime.ts
init_permissions();
init_structured_output();
init_acceptance();
init_tool_budget();
init_types();
init_utils();

// ../../../../tmp/vrtbuild/src/watchdog/diff-tool.ts
import { Type as Type3 } from "typebox";
var WatchdogDiffParams = Type3.Object({
  path: Type3.Optional(Type3.String({ description: "Restrict the diff to one file or directory, relative to the repo root." })),
  stat: Type3.Optional(Type3.Boolean({ description: "Return per-file change counts instead of the full diff." }))
}, { additionalProperties: false });

// ../../../../tmp/vrtbuild/src/shared/artifacts.ts
init_types();
init_utils();
var PROJECT_SUBAGENTS_RELATIVE_DIR = ".pi/subagents";
var PROJECT_ARTIFACT_PATHS = [
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/output.md`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_input.md`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_output.md`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker.jsonl`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_transcript.jsonl`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_meta.json`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/progress/run/progress.md`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/outputs/output.md`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/outputs/run/output.md`,
  `${PROJECT_SUBAGENTS_RELATIVE_DIR}/chain-runs/run.json`
];

// ../../../../tmp/vrtbuild/src/watchdog/change-signature.ts
var IGNORED_CHANGE_PREFIXES = [`${PROJECT_SUBAGENTS_RELATIVE_DIR}/`, "tmp/", "node_modules/"];
var DEFAULT_MAX_HASH_FILE_BYTES = 64 * 1024 * 1024;
var DEFAULT_MAX_HASH_TOTAL_BYTES = 64 * 1024 * 1024;

// ../../../../tmp/vrtbuild/src/watchdog/rules.ts
init_model_info();

// ../../../../tmp/vrtbuild/src/watchdog/settings.ts
init_model_info();
init_utils();
init_settings_file_lease();
init_types2();
var DEFAULT_WATCHDOG_CONFIG = {
  enabled: false,
  clarification: false,
  agentEndTimeoutMs: 3e4,
  severityThreshold: "concern",
  maxWarnings: null,
  guidance: {
    watchdogMd: true
  },
  stalemateRepeats: 3,
  scope: {
    enabled: true
  },
  cadence: {
    everyNTools: null
  },
  main: {
    enabled: false
  },
  children: {
    enabled: false,
    watchdogTailTimeoutMs: 12e4,
    overrides: {}
  },
  lsp: {
    enabled: true,
    timeoutMs: 3e3,
    maxFiles: 20,
    maxDiagnostics: 50
  }
};

// ../../../../tmp/vrtbuild/src/watchdog/warning-format.ts
init_types2();

// ../../../../tmp/vrtbuild/src/watchdog/turn-delta.ts
init_types2();

// ../../../../tmp/vrtbuild/src/watchdog/runtime.ts
init_types2();

// ../../../../tmp/vrtbuild/src/watchdog/review.ts
init_model_resolution();
import { Agent } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools, convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type as Type4 } from "typebox";

// ../../../../tmp/vrtbuild/src/shared/agent-stream-options.ts
function agentStreamOptions(streamFn) {
  return { streamFunction: streamFn, streamFn };
}

// ../../../../tmp/vrtbuild/src/shared/opencode-session-headers.ts
var OPENCODE_HOST = "opencode.ai";
function matchesOpenCodeHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}
function opencodeSessionHeaders(model2, sessionId) {
  if (!sessionId) return void 0;
  if (model2.provider !== "opencode" && model2.provider !== "opencode-go" && !matchesOpenCodeHost(model2.baseUrl)) return void 0;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

// ../../../../tmp/vrtbuild/src/watchdog/review.ts
init_model_info();

// ../../../../tmp/vrtbuild/src/watchdog/guidance.ts
init_utils();

// ../../../../tmp/vrtbuild/src/watchdog/review.ts
init_types2();
var WatchdogAskParams = Type4.Object({ question: Type4.String(), evidence: Type4.String() }, { additionalProperties: false });
var WatchdogWarnParams = Type4.Object({
  severity: Type4.String({ enum: WATCHDOG_WARNING_SEVERITIES, description: "concern for actionable risk, blocker for a likely wrong or unsafe outcome" }),
  importance: Type4.String({ enum: WATCHDOG_WARNING_IMPORTANCES, description: "low or medium for user-only visibility; high when the parent model must receive the finding" }),
  summary: Type4.String({ description: "One concise sentence naming the issue." }),
  evidence: Type4.String({ description: "Specific evidence from the turn delta or inspected files." }),
  recommendedAction: Type4.String({ description: "Specific action the parent should take before accepting or continuing." }),
  category: Type4.Optional(Type4.String({ enum: WATCHDOG_WARNING_CATEGORIES }))
}, { additionalProperties: false });
function fullModelId(model2) {
  return `${model2.provider}/${model2.id}`;
}
function splitProviderModel(value) {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) return void 0;
  return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) };
}
function assertThinkingLevel(value, source) {
  if (THINKING_LEVELS.includes(value)) return value;
  throw new Error(`Unsupported watchdog thinking level '${value}' from ${source}; expected ${THINKING_LEVELS.join(", ")} or false.`);
}
function contextThinkingLevel(ctx, currentThinkingLevel) {
  if (currentThinkingLevel) return currentThinkingLevel;
  const value = ctx.thinkingLevel;
  return typeof value === "string" && THINKING_LEVELS.includes(value) ? value : void 0;
}
function resolveReviewThinking(input) {
  const fromModelOrConfig = resolveEffectiveThinking(input.modelString, input.configThinking);
  if (fromModelOrConfig) return assertThinkingLevel(fromModelOrConfig, "watchdog model/config");
  if (input.configThinking === false) return "off";
  if (input.configThinking !== void 0) return assertThinkingLevel(input.configThinking, "watchdog config");
  if (input.allowContextThinking) return contextThinkingLevel(input.ctx, input.currentThinkingLevel) ?? "off";
  return "off";
}
function resolveConfiguredModel(ctx, rawModel) {
  const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
  const preferredProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider : void 0;
  const resolved = resolveModelCandidate(rawModel, availableModels, preferredProvider);
  if (!resolved) {
    throw new Error(`Configured watchdog model '${rawModel}' did not match exactly one authenticated available model. Use provider/model or configure credentials for the intended provider.`);
  }
  const { baseModel } = splitKnownThinkingSuffix(resolved);
  const named = splitProviderModel(baseModel);
  if (!named) {
    throw new Error(`Configured watchdog model '${rawModel}' did not match exactly one authenticated available model. Use provider/model or configure credentials for the intended provider.`);
  }
  const model2 = ctx.modelRegistry.find(named.provider, named.id);
  if (!model2) throw new Error(`Configured watchdog model '${rawModel}' was not found as '${baseModel}'.`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model2)) {
    throw new Error(`Configured watchdog model '${baseModel}' is not authenticated. Configure credentials for provider '${named.provider}' or choose an authenticated model.`);
  }
  return { model: model2, modelString: resolved };
}
var WatchdogAuthError = class extends Error {
};
async function resolveReviewAuth(ctx, model2) {
  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model2);
  } catch (error) {
    throw new WatchdogAuthError(`Watchdog model auth failed for ${fullModelId(model2)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (auth.ok === false) throw new WatchdogAuthError(`Watchdog model auth failed for ${fullModelId(model2)}: ${auth.error}`);
  return {
    ...auth.apiKey ? { apiKey: auth.apiKey } : {},
    ...auth.headers ? { headers: auth.headers } : {},
    ...auth.env ? { env: auth.env } : {}
  };
}
async function resolveWatchdogReviewModel(ctx, config, options = {}) {
  if (config.main.model) {
    const resolved = resolveConfiguredModel(ctx, config.main.model);
    return {
      model: resolved.model,
      thinkingLevel: resolveReviewThinking({
        modelString: resolved.modelString,
        configThinking: config.main.thinking,
        ctx,
        allowContextThinking: false,
        currentThinkingLevel: options.currentThinkingLevel
      }),
      auth: await resolveReviewAuth(ctx, resolved.model),
      explicit: true
    };
  }
  const currentModel = ctx.model;
  if (!currentModel) {
    throw new Error("Main watchdog review cannot run because the current Pi session model is unavailable and subagents.watchdog.main.model is not configured.");
  }
  return {
    model: currentModel,
    thinkingLevel: resolveReviewThinking({
      modelString: fullModelId(currentModel),
      configThinking: config.main.thinking,
      ctx,
      allowContextThinking: true,
      currentThinkingLevel: options.currentThinkingLevel
    }),
    auth: await resolveReviewAuth(ctx, currentModel),
    explicit: false
  };
}
function formatWatchdogCwdSection(cwd2) {
  if (/[\p{Cc}\p{Zl}\p{Zp}<>]/u.test(cwd2)) throw new Error("Watchdog cwd cannot contain control, line-separator, or angle-bracket characters.");
  return `<cwd>
${cwd2}
</cwd>`;
}

// ../../../../tmp/vrtbuild/src/watchdog/register-child.ts
init_child_status();
init_types2();
function childResolvedConfig(config) {
  return {
    ...DEFAULT_WATCHDOG_CONFIG,
    enabled: true,
    agentEndTimeoutMs: config.agentEndTimeoutMs,
    maxWarnings: config.maxWarnings,
    main: {
      enabled: true,
      ...config.model ? { model: config.model } : {},
      ...config.thinking !== void 0 ? { thinking: config.thinking } : {}
    },
    stalemateRepeats: config.stalemateRepeats,
    cadence: { ...config.cadence },
    children: {
      ...DEFAULT_WATCHDOG_CONFIG.children,
      watchdogTailTimeoutMs: config.watchdogTailTimeoutMs
    },
    lsp: { ...config.lsp }
  };
}

// ../../../../tmp/vrtbuild/src/watchdog/permission-arbiter.ts
init_permissions();
import { Agent as Agent2 } from "@earendil-works/pi-agent-core";
import { convertToLlm as convertToLlm2 } from "@earendil-works/pi-coding-agent";
import { Type as Type5 } from "typebox";
init_child_status();
var PermissionDecisionParams = Type5.Object({
  decision: Type5.String({ enum: ["approve", "deny"] }),
  reason: Type5.String({ description: "One concise reason for this exact decision." })
}, { additionalProperties: false });
function conciseReason(value) {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : "Watchdog returned an empty reason.";
}
function createWatchdogPermissionArbiter(options = {}) {
  return async (request) => {
    const preview = permissionArgsPreview(request.args);
    const createdAt = Date.now();
    const auditBase = { type: "permission.request", createdAt, toolName: request.toolName, preview, matchedRule: "ask", decisionSource: "watchdog" };
    appendPermissionAudit(request.auditPath, auditBase);
    let completed = false;
    const finish = (approved, reason, decision2) => {
      const concise = conciseReason(reason);
      if (completed) return { approved, reason: concise, source: "watchdog" };
      completed = true;
      appendPermissionAudit(request.auditPath, {
        type: "permission.decision",
        createdAt: Date.now(),
        requestCreatedAt: createdAt,
        toolName: request.toolName,
        decision: decision2,
        approved,
        decisionSource: "watchdog",
        reason: concise
      });
      return { approved, reason: concise, source: "watchdog" };
    };
    let childConfig;
    try {
      childConfig = decodeChildWatchdogConfig(request.rawWatchdogConfig);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return finish(false, `Watchdog permission arbiter configuration is invalid: ${reason}`, "unavailable");
    }
    if (!childConfig) return finish(false, "Watchdog permission arbiter is unavailable because the child watchdog is disabled.", "unavailable");
    if (request.signal?.aborted || request.ctx.signal?.aborted) return finish(false, "Watchdog permission decision was cancelled.", "cancelled");
    let decision;
    const tool = {
      name: "watchdog_permission_decision",
      label: "Watchdog permission decision",
      description: "Approve or deny this exact child tool call. Call exactly once.",
      parameters: PermissionDecisionParams,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        if (!decision) decision = params;
        return { content: [{ type: "text", text: "Permission decision recorded." }], details: { recorded: true } };
      }
    };
    let timeout;
    let agent2;
    let abort;
    try {
      const run = async () => {
        const config = childResolvedConfig(childConfig);
        const selection = await resolveWatchdogReviewModel(request.ctx, config);
        const auth = selection.auth;
        const sessionId = request.ctx.sessionManager.getSessionId();
        const baseStreamFn = options.streamFn ?? ((model2, context, streamOptions) => request.ctx.modelRegistry.streamSimple(model2, context, streamOptions));
        const streamFn = (model2, context, streamOptions) => baseStreamFn(model2, context, {
          ...streamOptions,
          ...auth.apiKey ? { apiKey: auth.apiKey } : {},
          env: auth.env || streamOptions?.env ? { ...auth.env ?? {}, ...streamOptions?.env ?? {} } : void 0,
          headers: { ...opencodeSessionHeaders(model2, sessionId), ...streamOptions?.headers ?? {}, ...auth.headers ?? {} }
        });
        const systemPrompt = [
          "You are the pi-subagents watchdog permission arbiter.",
          "Decide only whether this exact non-bash child tool call should proceed.",
          "Call watchdog_permission_decision exactly once with approve or deny and a concise reason.",
          "Deny when uncertain. Do not produce freeform advice or ask the parent orchestrator.",
          "",
          formatWatchdogCwdSection(request.ctx.cwd)
        ].join("\n");
        const tools = [tool];
        agent2 = new Agent2({
          initialState: {
            systemPrompt,
            model: selection.model,
            thinkingLevel: selection.thinkingLevel,
            tools
          },
          convertToLlm: convertToLlm2,
          ...agentStreamOptions(streamFn),
          getApiKey: (providerName) => providerName === selection.model.provider ? auth.apiKey : void 0,
          beforeToolCall: async ({ toolCall }) => toolCall.name === tool.name ? void 0 : { block: true, reason: `Permission arbiter tool '${toolCall.name}' is not allowed.` },
          toolExecution: "sequential"
        });
        await agent2.prompt(`Tool: ${request.toolName}
Redacted arguments: ${preview}`);
        if (!decision) return finish(false, "Watchdog permission arbiter returned no decision.", "malformed");
        const approved = decision.decision === "approve";
        return finish(approved, decision.reason, decision.decision);
      };
      return await Promise.race([
        run(),
        new Promise((resolve11) => {
          timeout = setTimeout(() => {
            agent2?.abort();
            resolve11(finish(false, "Watchdog permission decision timed out.", "timeout"));
          }, childConfig.agentEndTimeoutMs);
        }),
        new Promise((resolve11) => {
          abort = () => {
            agent2?.abort();
            resolve11(finish(false, "Watchdog permission decision was cancelled.", "cancelled"));
          };
          request.signal?.addEventListener("abort", abort, { once: true });
          request.ctx.signal?.addEventListener("abort", abort, { once: true });
        })
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return finish(false, `Watchdog permission arbiter failed closed: ${reason}`, reason.includes("timed out") ? "timeout" : "error");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) {
        request.signal?.removeEventListener("abort", abort);
        request.ctx.signal?.removeEventListener("abort", abort);
      }
    }
  };
}
var requestWatchdogPermission = createWatchdogPermissionArbiter();

// ../../../../tmp/vrtbuild/src/runs/shared/subagent-prompt-runtime.ts
init_types2();

// ../../../../tmp/vrtbuild/src/runs/shared/nested-events.ts
init_types();
import * as path13 from "node:path";
init_atomic_json();

// ../../../../tmp/vrtbuild/src/runs/background/process-terminal.ts
init_atomic_json();
init_types();

// ../../../../tmp/vrtbuild/src/runs/shared/session-lease.ts
init_atomic_json();
init_types();
import * as path12 from "node:path";
var SESSION_LEASES_DIR = path12.join(TEMP_ROOT_DIR, "session-leases");

// ../../../../tmp/vrtbuild/src/runs/background/active-run-index.ts
init_utils();

// ../../../../tmp/vrtbuild/src/runs/background/index-segment.ts
var MAX_INDEX_SEGMENT_BYTES = 255;

// ../../../../tmp/vrtbuild/src/runs/background/terminal-run-index.ts
init_utils();
init_atomic_json();

// ../../../../tmp/vrtbuild/src/runs/background/active-run-index.ts
init_file_system_retry();
var DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS = 24 * 60 * 60 * 1e3;

// ../../../../tmp/vrtbuild/src/runs/background/process-terminal-candidate.ts
init_atomic_json();

// ../../../../tmp/vrtbuild/src/runs/shared/nested-events.ts
init_model_info();
var NESTED_EVENTS_DIR = path13.join(TEMP_ROOT_DIR, "nested-subagent-events");
var MAX_EVENT_BYTES = 64 * 1024;

// ../../../../tmp/vrtbuild/src/extension/schemas.ts
import { Type as Type6 } from "typebox";

// ../../../../tmp/vrtbuild/src/workflows/structured-workflow-scripts.ts
var SETTLE_HELPER = [
  "function settle(results, agents) {",
  "  return results.map(function (result, index) {",
  '    const child = { key: result.key, agent: agents[index], ok: result.ok === true, output: typeof result.output === "string" ? result.output : "" };',
  '    if (!child.ok && typeof result.error === "string") child.error = result.error;',
  "    return child;",
  "  });",
  "}",
  // A failed child fails the workflow; the runtime keeps every settled child in the partial results.
  "function failure(label, children) {",
  '  return new Error(label + ": " + children.filter(function (child) { return !child.ok; }).map(function (child) { return child.key + " (" + child.agent + ") failed" + (child.error ? ": " + child.error : ""); }).join("; "));',
  "}"
].join("\n");

// ../../../../tmp/vrtbuild/src/workflows/workflow-resources.ts
var MAX_ARGS_BYTES = 16 * 1024;
var MAX_ARGS_FIELDS = 16;
var MAX_ARGS_ITEMS = 64;
var MAX_ARGS_DEPTH = 8;
var MAX_STRING_BYTES = 16 * 1024;

// ../../../../tmp/vrtbuild/src/extension/schemas.ts
function keepTopLevelParameterDescriptions(schema) {
  return pruneNestedDescriptions(schema, []);
}
function pruneNestedDescriptions(value, path16) {
  if (!value || typeof value !== "object") return value;
  const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (key === "description" && !isTopLevelParameterDescription(path16)) continue;
    if ("value" in descriptor) {
      const nextPath = typeof key === "string" ? [...path16, key] : path16;
      descriptor.value = pruneNestedDescriptions(descriptor.value, nextPath);
    }
    Object.defineProperty(result, key, descriptor);
  }
  return result;
}
function isTopLevelParameterDescription(path16) {
  return path16.length === 2 && path16[0] === "properties";
}
var SkillOverride = Type6.Unsafe({
  anyOf: [
    { type: "array", items: { type: "string" } },
    { type: "boolean" },
    { type: "string" }
  ],
  description: "Skills: names/CSV/array; false disables, true uses default."
});
var OutputModeOverride = Type6.String({
  enum: ["inline", "file-only"],
  description: "Default inline; file-only requires output path."
});
var JsonSchemaObject = Type6.Unsafe({
  type: "object",
  additionalProperties: true,
  description: "Strict structured output; object-root JSON Schema only."
});
var OutputSchemaOverride = Type6.Unsafe({
  anyOf: [JsonSchemaObject, { type: "boolean" }],
  description: "Structured output schema override; false disables an agent default."
});
var AcceptanceOverride = Type6.Unsafe({
  anyOf: [
    { type: "string", enum: ["auto", "attested", "checked"] },
    {
      type: "string",
      enum: ["reviewed"],
      description: "Invalid as an explicit policy. Recognized only so preflight can explain that reviewed is an achieved status."
    },
    {
      type: "string",
      pattern: "^\\s*\\{[\\s\\S]*$"
    },
    { type: "boolean" },
    { type: "object", additionalProperties: true }
  ],
  description: "Evidence policy; omit for read-only/review. false disables; true invalid. Prefer object; see guide tool-reference for levels, evidence and review.required."
});
var AgentContractOverride = Type6.Object({
  version: Type6.Integer({ minimum: 1, maximum: 1, description: "Enable compatibility behavior for this run/child." })
}, { additionalProperties: false, description: "Compatibility behavior. Omit for the default behavior." });
var WorkflowLaneMetadata = Type6.Object({
  version: Type6.Integer({ minimum: 1, maximum: 1 }),
  key: Type6.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
  mode: Type6.Optional(Type6.String({ enum: ["mutation", "review", "scout", "gate"] })),
  sourceRef: Type6.Optional(Type6.String({ minLength: 1, maxLength: 128 })),
  claims: Type6.Optional(Type6.Array(Type6.String({ minLength: 1, maxLength: 160 }), { maxItems: 20 })),
  outputPaths: Type6.Optional(Type6.Array(Type6.String({ minLength: 1, maxLength: 256 }), { maxItems: 10 }))
}, { additionalProperties: false, description: "Display/triage only; sourceRef is opaque, never resolved by status." });
var ToolBudgetBlock = Type6.Unsafe({
  anyOf: [
    { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    { type: "string", enum: ["*"] }
  ]
});
var ToolBudgetOverride = Type6.Object({
  soft: Type6.Optional(Type6.Integer({ minimum: 1 })),
  hard: Type6.Integer({ minimum: 1 }),
  block: Type6.Optional(ToolBudgetBlock)
}, { additionalProperties: false, description: "soft <= hard; after hard block read/grep/find/ls or '*' for all." });
var UsageBudgetLimitOverride = Type6.Object({
  soft: Type6.Optional(Type6.Number({ exclusiveMinimum: 0 })),
  hard: Type6.Number({ exclusiveMinimum: 0 })
}, { additionalProperties: false });
var UsageBudgetOverride = Type6.Object({
  tokens: Type6.Optional(UsageBudgetLimitOverride),
  costUsd: Type6.Optional(UsageBudgetLimitOverride)
}, { additionalProperties: false, minProperties: 1, description: "tokens or costUsd; soft <= hard. Root-only reported usage; blocks launches. Running children are not stopped." });
var WorkflowPreflightLane = Type6.Object({
  key: Type6.String({ minLength: 1, maxLength: 128 }),
  mode: Type6.Optional(Type6.String({ enum: ["mutation", "review", "scout", "gate"] })),
  decision: Type6.Optional(Type6.String({ maxLength: 256 })),
  claims: Type6.Optional(Type6.Array(Type6.String({ maxLength: 256 }), { maxItems: 16 })),
  expectedOutput: Type6.Optional(Type6.String({ maxLength: 256 })),
  independence: Type6.Optional(Type6.String({ maxLength: 256 }))
}, { additionalProperties: false });
var WorkflowPreflightOverride = Type6.Object({
  version: Type6.Integer({ minimum: 1, maximum: 1 }),
  coverage: Type6.Optional(Type6.String({ enum: ["complete", "partial"] })),
  lanes: Type6.Array(WorkflowPreflightLane, { maxItems: 64 })
}, { additionalProperties: false, description: "workflow: true or a script path only; display-only hints; coverage warns." });
var MissionLaunchOverride = Type6.Unsafe({
  anyOf: [
    { type: "object", additionalProperties: true },
    { type: "boolean" }
  ]
});
var MissionUpdateOverride = Type6.Unsafe({ type: "object", additionalProperties: true });
var ControlOverrides = Type6.Object({
  enabled: Type6.Optional(Type6.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
  needsAttentionAfterMs: Type6.Optional(Type6.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" })),
  activeNoticeAfterMs: Type6.Optional(Type6.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" })),
  activeNoticeAfterTurns: Type6.Optional(Type6.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by assistant turns (disabled by default)" })),
  activeNoticeAfterTokens: Type6.Optional(Type6.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by total tokens (disabled by default)" })),
  failedToolAttemptsBeforeAttention: Type6.Optional(Type6.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)" })),
  notifyOn: Type6.Optional(Type6.Array(Type6.String({ enum: ["active_long_running", "needs_attention"] }), {
    description: "Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention."
  })),
  notifyChannels: Type6.Optional(Type6.Array(Type6.String({ enum: ["event", "async", "intercom"] }), {
    description: "Notification channels to use when available. Defaults to event, async, and intercom."
  }))
});
var SubagentParamProperties = {
  agent: Type6.Optional(Type6.String({ description: "One-child agent or management target." })),
  task: Type6.Optional(Type6.String({ description: "One-child task; requires agent." })),
  extensionBindings: Type6.Optional(Type6.Unsafe({ type: "object", maxProperties: 16, additionalProperties: true, description: "Child-only plain JSON; package.name/1; depth 16, 256 props, 16 KiB." })),
  // Management action (when present, tool operates in management mode)
  action: Type6.Optional(Type6.String({
    minLength: 1,
    description: 'Management/control only; omit for execution. validate accepts workflow: true or a script path. Discover actions with {action:"guide",options:{topic:"tool-reference"}}.'
  })),
  capabilities: Type6.Optional(Type6.Boolean({ description: "list: compact capability rows/details without system prompts." })),
  name: Type6.Optional(Type6.String({ description: "schedule.create name." })),
  id: Type6.Optional(Type6.String({
    description: "Run id/prefix for status/control."
  })),
  runId: Type6.Optional(Type6.String({
    description: "Target run ID; prefer id."
  })),
  dir: Type6.Optional(Type6.String({
    description: "Async directory for status/control."
  })),
  handoffPath: Type6.Optional(Type6.String({ description: "Existing manifest for worktree/lane actions." })),
  repo: Type6.Optional(Type6.String({ description: "Cleanup repo; apply requires it." })),
  planId: Type6.Optional(Type6.String({ description: "Reviewed cleanup plan for apply." })),
  laneId: Type6.Optional(Type6.String({ minLength: 1, maxLength: 128, description: "Exact manifest run id for lane actions." })),
  merge: Type6.Optional(Type6.Unsafe({ type: "object", additionalProperties: true, description: "lane.recordMerge evidence; read guide tool-reference." })),
  supersession: Type6.Optional(Type6.Unsafe({ type: "object", additionalProperties: true, description: "lane.recordSupersession evidence; read guide tool-reference." })),
  index: Type6.Optional(Type6.Integer({ minimum: 0, description: "Zero-based child/transcript index." })),
  childId: Type6.Optional(Type6.String({ minLength: 1, maxLength: 256, description: "Child-scoped stop identity." })),
  toolCallId: Type6.Optional(Type6.String({ description: "Command tool-call id." })),
  view: Type6.Optional(Type6.String({
    enum: ["fleet", "transcript"],
    description: "status view: fleet overview or transcript tail with id/dir and optional index."
  })),
  lines: Type6.Optional(Type6.Integer({ minimum: 1, maximum: 500, description: "Transcript tail lines; default 80." })),
  topic: Type6.Optional(Type6.String()),
  message: Type6.Optional(Type6.String({ description: "resume/steer guidance or project.open prompt." })),
  mode: Type6.Optional(Type6.String({ enum: ["steer", "follow_up", "auto", "plan", "apply"], description: "steer delivery; worktree.cleanup plan/apply (reviewed planId)." })),
  steeringRecovery: Type6.Optional(Type6.Boolean({ description: "steer: pause/revive after missed acknowledgment; default true in direct steer mode, forced false by extension RPC for exact ownership." })),
  additional: Type6.Optional(Type6.Integer({ minimum: 1, description: "grant-spawn-budget: root interactive parent + native user confirmation only; total grants capped at original configured cap." })),
  scope: Type6.Optional(Type6.String({ enum: ["session", "user", "project"], description: "watchdog.configure scope; default session, persistent only if explicit." })),
  target: Type6.Optional(Type6.String({ enum: ["main", "children", "child"], description: "Watchdog target." })),
  focus: Type6.Optional(Type6.Boolean({ description: "Focus inspector.open/project.open pane." })),
  thinking: Type6.Optional(Type6.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean" }], description: "watchdog.configure only: off/minimal/low/medium/high/xhigh/max, inherit, false=off; true invalid. Dispatch ignores this; use model suffix." })),
  at: Type6.Optional(Type6.String({ description: "Delay/ISO or local HH:mm." })),
  every: Type6.Optional(Type6.String({ description: "Duration or day/week." })),
  sessionOnly: Type6.Optional(Type6.Boolean()),
  quiet: Type6.Optional(Type6.Boolean()),
  on: Type6.Optional(Type6.Array(Type6.String({ enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }), { minItems: 1, description: "Weekly." })),
  timezone: Type6.Optional(Type6.String({ description: "IANA/UTC." })),
  overlap: Type6.Optional(Type6.String({ enum: ["skip"] })),
  catchUp: Type6.Optional(Type6.String({ enum: ["none", "latest"], description: "Missed; default latest." })),
  missionId: Type6.Optional(Type6.String({ description: "Existing mission to attach to a workflow or schedule.create; read guide missions for lifecycle and retention." })),
  mission: Type6.Optional(Type6.Unsafe({ ...MissionLaunchOverride, description: "false disables; true invalid. Object: exactly one non-empty title or summary; objective/labels optional; goal only true, requires budget.tokens." })),
  missionUpdate: Type6.Optional(Type6.Unsafe({ ...MissionUpdateOverride, description: "Mission patch; read guide missions." })),
  missionStatus: Type6.Optional(Type6.String()),
  missionScope: Type6.Optional(Type6.String({ description: "project (default) or global pointer index." })),
  runMode: Type6.Optional(Type6.String({ description: "Attached run mode." })),
  runStatus: Type6.Optional(Type6.String({ description: "Attached run status." })),
  summary: Type6.Optional(Type6.String({ description: "Mission close summary." })),
  // Agent configuration for create/update (nested to avoid conflicts with execution fields)
  config: Type6.Optional(Type6.Unsafe({
    anyOf: [
      { type: "object", additionalProperties: true },
      { type: "string" }
    ],
    description: "create/update agent config; object or JSON string."
  })),
  workflow: Type6.Optional(Type6.Unsafe({
    anyOf: [{ type: "boolean" }, { type: "string", minLength: 1 }],
    description: "true: run the one ```js workflow block written in this same reply (false invalid). String with '/': script file read from request cwd. Other string: named workflow resource. Raw scripts (true or path) have no runs.host."
  })),
  args: Type6.Optional(Type6.Unsafe({ type: "object", maxProperties: MAX_ARGS_FIELDS, additionalProperties: true, description: `Plain-JSON args for workflow; ${MAX_ARGS_FIELDS} fields/object, ${MAX_ARGS_ITEMS} items/array, depth ${MAX_ARGS_DEPTH}, ${MAX_ARGS_BYTES / 1024} KiB total; raw-script args are exposed deeply frozen and persisted, so do not include secrets.` })),
  reuseFrom: Type6.Optional(Type6.String({ minLength: 1, description: "Exact id of a workflow run stopped by a session handoff or reload; this async workflow reuses its finished children and re-attaches to its running ones." })),
  globalConcurrencyLimit: Type6.Optional(Type6.Integer({ minimum: 1 })),
  maxSubagentSpawnsPerRun: Type6.Optional(Type6.Integer({ minimum: 1 })),
  preflight: Type6.Optional(WorkflowPreflightOverride),
  chatProgress: Type6.Optional(Type6.String({ enum: ["auto", "off", "live-card"], description: "auto: live card only for watched foreground in same Git repository. live-card requires same-repo async:false; async: omit or auto/off." })),
  isolation: Type6.Optional(Type6.String({ enum: ["none", "worktree"], description: "Shared cwd or managed git worktrees." })),
  worktree: Type6.Optional(Type6.Boolean({ description: "Isolate each workflow child in a managed git worktree; child worktree:false overrides default." })),
  baseRef: Type6.Optional(Type6.String()),
  lane: Type6.Optional(WorkflowLaneMetadata),
  context: Type6.Optional(Type6.String({
    enum: ["fresh", "fork", "profile"],
    description: "fresh/fork overrides every child; profile requires agent's declared defaultContext, ignoring config. Omitted: defaultSubagentContext wins over each agent defaultContext; implicit fork needs persisted parent + leaf, else fresh. forkContext may prune forks before spawn."
  })),
  async: Type6.Optional(Type6.Boolean({ description: "Background; default asyncByDefault. false only to block parent." })),
  timeoutMs: Type6.Optional(Type6.Integer({ minimum: 1, description: "Foreground and single async runs use config timeoutMs, else 30m; async composites have no default parent deadline. Alias maxRuntimeMs; must agree." })),
  maxRuntimeMs: Type6.Optional(Type6.Integer({ minimum: 1, description: "Alias timeoutMs (same defaults)." })),
  checkpointBeforeDeadlineMs: Type6.Optional(Type6.Integer({ minimum: 1, maximum: 2147483647, description: "Async single-agent runs only: the runner requests that the child checkpoint and stop this many ms before the run deadline (best-effort; the deadline kill still applies)." })),
  toolTimeoutMs: Type6.Optional(Type6.Integer({ minimum: 1, description: "Per-tool deadline (ms); fast builtins default 5m." })),
  toolBudget: Type6.Optional(ToolBudgetOverride),
  usageBudget: Type6.Optional(UsageBudgetOverride),
  agentScope: Type6.Optional(Type6.String({ description: "user/project/both (default); project wins collisions." })),
  cwd: Type6.Optional(Type6.String({ description: "Execution/project-pane directory." })),
  machine: Type6.Optional(Type6.String({ minLength: 1, maxLength: 128, description: "Herdr saved machine id or label; runs an external CLI agent there. cwd then means the directory on that machine." })),
  artifacts: Type6.Optional(Type6.Boolean({ description: "Debug artifacts; default true." })),
  includeProgress: Type6.Optional(Type6.Boolean({ description: "Full result progress; default false." })),
  share: Type6.Optional(Type6.Boolean({ description: "Upload session to GitHub Gist; default false." })),
  sessionDir: Type6.Optional(
    Type6.String({ description: "Session log directory; default temp, independent of share." })
  ),
  control: Type6.Optional(ControlOverrides),
  // Workflow defaults forwarded to each runs.run/runs.all child unless overridden there.
  output: Type6.Optional(Type6.Unsafe({
    anyOf: [
      { type: "string" },
      { type: "boolean" }
    ],
    description: "Child output path or false; relative workflow paths use managed artifact routing. Bind durable output here, not task prose; return outputReference/outputPathMapping/artifactPaths."
  })),
  outputMode: Type6.Optional(OutputModeOverride),
  maxOutput: Type6.Optional(Type6.Object({ bytes: Type6.Optional(Type6.Integer({ minimum: 1 })), lines: Type6.Optional(Type6.Integer({ minimum: 1 })) }, { additionalProperties: false })),
  skill: Type6.Optional(SkillOverride),
  model: Type6.Optional(Type6.String({ description: "Child model provider/id; bare id only if unique. Suffix :off/minimal/low/medium/high/xhigh/max overrides agent thinking default." })),
  fast: Type6.Optional(Type6.Boolean({ description: "Native OpenAI-Codex priority tier; default false, may cost more/quota." })),
  outputSchema: Type6.Optional(OutputSchemaOverride),
  agentContract: Type6.Optional(AgentContractOverride),
  acceptance: Type6.Optional(AcceptanceOverride),
  gate: Type6.Optional(Type6.Unsafe({
    anyOf: [
      { type: "string", minLength: 1 },
      { type: "object", properties: { command: { type: "string", minLength: 1 }, output: { type: "string", enum: ["json"] }, schema: { type: "object" }, timeoutMs: { type: "integer", minimum: 1 } }, required: ["command"], additionalProperties: false }
    ],
    description: 'Host gate command run after the child finishes: a string, or an object; with output "json", passing stdout becomes structuredOutput (not with outputSchema). Cannot be combined with acceptance except false (treated as omitted).'
  }))
};
var SubagentFlatParams = Type6.Object(SubagentParamProperties);
var { runId: _runId, maxRuntimeMs: _maxRuntimeMs, isolation: _isolation, ...ModelProperties } = SubagentParamProperties;
var { agent, task, workflow, args, async, model, cwd, worktree, output, action, id, message, ...SubagentOptionProperties } = ModelProperties;
var SUBAGENT_OPTION_KEYS = Object.keys(SubagentOptionProperties);
var SubagentOptionParams = Type6.Object(SubagentOptionProperties, { additionalProperties: false });
var ModelTopLevelProperties = {
  agent,
  task,
  workflow,
  args,
  async,
  model,
  cwd,
  worktree,
  output,
  action,
  id,
  message,
  options: Type6.Optional(Type6.Unsafe({ type: "object", additionalProperties: true, description: "Every field not listed here, such as acceptance, timeoutMs, context, view and index; guide tool-reference/parameter-reference." }))
};
var SubagentParams = keepTopLevelParameterDescriptions(Type6.Object(ModelTopLevelProperties));
var StructuredTask = { type: "object", properties: { agent: { type: "string", minLength: 1 }, task: { type: "string" } }, required: ["agent", "task"], additionalProperties: false };
var StructuredWorkflowProperties = {
  action: Type6.Optional(Type6.String({ minLength: 1, description: 'Management/control only; omit for execution. Discover actions with {action:"guide",options:{topic:"tool-reference"}}.' })),
  task: Type6.Optional(Type6.String({ description: "One-child task with agent, or the original request ({task}) with chain/tasks." })),
  tasks: Type6.Optional(Type6.Unsafe({ type: "array", minItems: 1, items: StructuredTask, description: "Parallel children; results in order." })),
  // Flattened step: {agent, task?, as?} or {parallel}; no object-shape union for provider converters.
  chain: Type6.Optional(Type6.Unsafe({
    type: "array",
    minItems: 1,
    items: { type: "object", properties: { agent: { type: "string", minLength: 1 }, task: { type: "string" }, as: { type: "string" }, parallel: { type: "array", minItems: 1, items: StructuredTask } }, additionalProperties: false },
    description: "Sequential steps: {agent,task?,as?} or {parallel:[{agent,task}]}."
  }))
};
var SubagentWaitParamsSchema = Type6.Object({
  id: Type6.Optional(Type6.String({ description: "Run id or prefix." })),
  nonBlocking: Type6.Optional(Type6.Boolean({ description: "Subscribe to id's wake and return immediately; requires id, not with all." })),
  all: Type6.Optional(Type6.Boolean({ description: "Wait for all work active at call time." })),
  timeoutMs: Type6.Optional(Type6.Integer({ minimum: 1, description: "Max wait; default waitTool.defaultTimeoutMs, then 30 min." })),
  stopOnAttention: Type6.Optional(Type6.Boolean({ description: "false: keep waiting through idle or long-thinking attention." }))
});
var SubagentWaitParams = keepTopLevelParameterDescriptions(SubagentWaitParamsSchema);

// ../../../../tmp/vrtbuild/src/runs/background/async-status.ts
init_formatters();
init_display_text();
init_utils();

// ../../../../tmp/vrtbuild/src/runs/shared/nested-render.ts
init_formatters();

// ../../../../tmp/vrtbuild/src/runs/shared/run-fanout-budget.ts
init_file_system_retry();
init_types();
import * as path14 from "node:path";
var RUN_FANOUT_ROOT = path14.join(TEMP_ROOT_DIR, "run-fanout-budgets");

// ../../../../tmp/vrtbuild/src/runs/background/stale-run-reconciler.ts
init_atomic_json();

// ../../../../tmp/vrtbuild/src/runs/background/result-files.ts
init_atomic_json();
init_file_lease();

// ../../../../tmp/vrtbuild/src/missions/lifecycle.ts
init_atomic_json();
init_utils();

// ../../../../tmp/vrtbuild/src/missions/types.ts
var MISSION_STATUSES = [
  "planned",
  "active",
  "waiting",
  "needs_decision",
  "completed",
  "failed",
  "cancelled"
];

// ../../../../tmp/vrtbuild/src/missions/workflow-state.ts
init_atomic_json();
init_file_system_retry();

// ../../../../tmp/vrtbuild/src/workflows/scripted-workflow.ts
import { createRequire } from "node:module";
init_parallel_utils();
init_acceptance();

// ../../../../tmp/vrtbuild/src/workflows/host-command.ts
init_acceptance();
init_owned_process_tree();
init_single_output();
init_file_system_retry();
var MAX_COMMAND_BYTES = 16 * 1024;
var MAX_CAPTURE_BYTES = 1024 * 1024;
var MAX_PREVIEW_BYTES2 = 4 * 1024;
var MAX_TIMEOUT_MS = 24 * 60 * 60 * 1e3;

// ../../../../tmp/vrtbuild/src/workflows/scripted-workflow.ts
var requireFromPackage = createRequire(import.meta.url);
var WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { inspect } = require("node:util");
const { parse } = require(workerData.acornPath);

let promiseHooks;
try {
  ({ promiseHooks } = require("node:v8"));
} catch {}

function createWorkflowPromiseHook(callbacks) {
  if (!promiseHooks || typeof promiseHooks.createHook !== "function") return () => {};
  try {
    return promiseHooks.createHook(callbacks);
  } catch (error) {
    if (error?.name !== "NotImplementedError") throw error;
    return () => {};
  }
}

let nextCallId = 0;
let topLevelWorkflowPromise;
let suppressNativePromiseConsumption = 0;
const activeNativePromises = [];
const pending = new Map();
const workflowErrorKinds = new WeakMap();
const runKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validGitRef(ref) {
  if (typeof ref !== "string" || !ref || ref === "@" || new TextEncoder().encode(ref).length > 1024 || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("..") || ref.includes("@{")) return false;
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(ref)) return false;
  if (/[[\]\\~^:?*\u0000-\u0020\u007f]/u.test(ref) || ref.endsWith(".") || ref.endsWith(".lock")) return false;
  return ref.split("/").every((component) => component.length > 0 && component !== "." && component !== ".." && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}
const trackedPromiseTrackers = new WeakMap();
const trackedPromiseTargets = new WeakMap();
let nativePromiseTrackers = new WeakMap();
let nativePromiseParents = new WeakMap();
const observedCallIds = new Set();

function stableRunJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableRunJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableRunJson(value[key])).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
}

function canonicalRunParams(params) {
  if (params.gate === undefined || params.acceptance !== false) return params;
  const { acceptance: _acceptance, ...withoutAcceptance } = params;
  return withoutAcceptance;
}

function isDirectWorkflowScriptPromiseHandlerCall() {
  const stack = new Error().stack;
  if (typeof stack !== "string") return false;
  return stack.split("\n").some((line) => line.includes("workflow-script.js") && !line.includes("at async "));
}

function nativePromiseTracker(promise) {
  if (!promise || (typeof promise !== "object" && typeof promise !== "function")) return undefined;
  let tracker = nativePromiseTrackers.get(promise);
  if (!tracker) {
    tracker = { observations: [], consumed: false, dependencies: [] };
    nativePromiseTrackers.set(promise, tracker);
  }
  return tracker;
}

function promiseObservationTracker(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return trackedPromiseTrackers.get(value) ?? nativePromiseTrackers.get(value);
}

function addTrackerDependency(tracker, dependency) {
  if (!dependency) return;
  tracker.dependencies ??= [];
  if (!tracker.dependencies.includes(dependency)) tracker.dependencies.push(dependency);
  if (tracker.consumed) markTrackedObservationsConsumed(dependency);
}

function descendsFromTopLevelWorkflow(promise) {
  const seen = new Set();
  for (let current = promise; current && !seen.has(current); current = nativePromiseParents.get(current)) {
    if (current === topLevelWorkflowPromise) return true;
    seen.add(current);
  }
  return false;
}

function withSuppressedNativePromiseConsumption(callback) {
  suppressNativePromiseConsumption++;
  try {
    return callback();
  } finally {
    suppressNativePromiseConsumption--;
  }
}

function mergeObservations(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const observation of group) {
      if (!observation || typeof observation.callId !== "number" || typeof observation.key !== "string" || typeof observation.operation !== "string" || seen.has(observation.callId)) continue;
      seen.add(observation.callId);
      merged.push(observation);
    }
  }
  return merged;
}

function trackedObservationTracker(value) {
  return value && (typeof value === "object" || typeof value === "function") ? trackedPromiseTrackers.get(value) : undefined;
}

function trackedPromiseTarget(value) {
  return value && (typeof value === "object" || typeof value === "function") ? trackedPromiseTargets.get(value) ?? value : value;
}

function addTrackedObservations(tracker, observations) {
  tracker.observations = mergeObservations(tracker.observations, observations);
  if (!tracker.consumed) return;
  for (const observation of tracker.observations) {
    if (observedCallIds.has(observation.callId)) continue;
    observedCallIds.add(observation.callId);
    parentPort.postMessage({ type: "callObserved", callId: observation.callId, key: observation.key, operation: observation.operation });
  }
}

function markTrackedObservationsConsumed(tracker, seen = new Set()) {
  if (seen.has(tracker)) return;
  seen.add(tracker);
  tracker.consumed = true;
  addTrackedObservations(tracker, []);
  for (const dependency of tracker.dependencies ?? []) markTrackedObservationsConsumed(dependency, seen);
}

function consumeTrackedObservations(tracker) {
  if (isDirectWorkflowScriptPromiseHandlerCall()) return;
  const activePromise = activeNativePromises.at(-1);
  if (activePromise === topLevelWorkflowPromise || descendsFromTopLevelWorkflow(activePromise)) {
    markTrackedObservationsConsumed(tracker);
  } else if (activePromise) {
    addTrackerDependency(nativePromiseTracker(activePromise), tracker);
  } else {
    markTrackedObservationsConsumed(tracker);
  }
}

function trackObservationTracker(tracker, promise, allowFutureObservations = false) {
  const target = trackedPromiseTarget(promise);
  if ((!allowFutureObservations && tracker.observations.length === 0) || !target || typeof target.then !== "function") return promise;

  const tracked = new Proxy(target, {
    get(promiseTarget, prop) {
      if (prop === "then") return function promiseThen(onFulfilled, onRejected) {
        consumeTrackedObservations(tracker);
        const chainTracker = { observations: tracker.observations, consumed: false, dependencies: [tracker] };
        const wrapHandler = (handler) => typeof handler === "function"
          ? function trackedThenHandler(...args) {
            const value = handler.apply(this, args);
            addTrackerDependency(chainTracker, promiseObservationTracker(value));
            return trackedPromiseTarget(value);
          }
          : handler;
        return trackObservationTracker(chainTracker, promiseTarget.then(wrapHandler(onFulfilled), wrapHandler(onRejected)), true);
      };
      if (prop === "catch") return function promiseCatch(onRejected) {
        consumeTrackedObservations(tracker);
        return trackObservationTracker({ observations: tracker.observations, consumed: false, dependencies: [tracker] }, promiseTarget.catch(onRejected), true);
      };
      if (prop === "finally") return function promiseFinally(onFinally) {
        consumeTrackedObservations(tracker);
        return trackObservationTracker({ observations: tracker.observations, consumed: false, dependencies: [tracker] }, promiseTarget.finally(onFinally), true);
      };
      return Reflect.get(promiseTarget, prop, promiseTarget);
    },
  });
  trackedPromiseTrackers.set(tracked, tracker);
  trackedPromiseTargets.set(tracked, target);
  return tracked;
}

function trackRunObservation(observations, promise) {
  const tracker = trackedObservationTracker(promise) ?? { observations: [], consumed: false };
  addTrackedObservations(tracker, observations);
  return trackObservationTracker(tracker, promise);
}

function trackPromiseCombinator(items, createPromise) {
  const values = Array.from(items);
  const dependencies = [...new Set(values.map(promiseObservationTracker).filter(Boolean))];
  const promise = withSuppressedNativePromiseConsumption(() => createPromise(values.map(trackedPromiseTarget)));
  if (dependencies.length === 0) return promise;
  return trackObservationTracker({ observations: [], consumed: false, dependencies }, promise, true);
}

// Hosts that freeze built-ins make Promise.all and friends non-writable and non-configurable, and a
// Proxy over Promise itself may not return wrappers for those. Proxy a plain constructor instead.
const workflowPromiseTarget = function Promise() {};
workflowPromiseTarget.prototype = Promise.prototype;
const workflowPromise = new Proxy(workflowPromiseTarget, {
  apply() {
    throw new TypeError("Promise constructor cannot be invoked without 'new'");
  },
  construct(_proxyTarget, [executor]) {
    const target = Promise;
    if (typeof executor !== "function") return new target(executor);
    const tracker = { observations: [], consumed: false };
    const promise = new target((resolve, reject) => {
      let settled = false;
      try {
        executor((value) => {
          if (settled) return;
          settled = true;
          addTrackerDependency(tracker, promiseObservationTracker(value));
          resolve(trackedPromiseTarget(value));
        }, (reason) => {
          if (settled) return;
          settled = true;
          reject(reason);
        });
      } catch (error) {
        settled = true;
        throw error;
      }
    });
    return trackObservationTracker(tracker, promise, true);
  },
  get(_proxyTarget, prop) {
    const target = Promise;
    if (prop === "all") return (items) => trackPromiseCombinator(items, (values) => target.all(values));
    if (prop === "allSettled") return (items) => trackPromiseCombinator(items, (values) => target.allSettled(values));
    if (prop === "race") return (items) => trackPromiseCombinator(items, (values) => target.race(values));
    if (prop === "any") return (items) => trackPromiseCombinator(items, (values) => target.any(values));
    if (prop === "resolve") return (value) => {
      const dependency = promiseObservationTracker(value);
      const promise = withSuppressedNativePromiseConsumption(() => target.resolve(trackedPromiseTarget(value)));
      if (!dependency) return promise;
      return trackObservationTracker({ observations: [], consumed: false, dependencies: [dependency] }, promise, true);
    };
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

function hostCall(method, args, observation) {
  const callId = ++nextCallId;
  const promise = new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "call", callId, method, args });
  });
  return observation && typeof observation.key === "string" && typeof observation.operation === "string"
    ? trackRunObservation([{ key: observation.key, operation: observation.operation, callId }], promise)
    : promise;
}

function runHostCall(key, params, collectFailure, batch, generatedLaneKey) {
  const callId = ++nextCallId;
  const promise = new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "call", callId, method: "run", args: { key, params, ...(collectFailure ? { collectFailure: true } : {}), ...(batch ? { batch } : {}), ...(generatedLaneKey ? { generatedLaneKey } : {}) } });
  });
  return { key, callId, promise };
}

function isArrayIndexProperty(prop) {
  if (!/^(0|[1-9]\d*)$/.test(prop)) return false;
  const index = Number(prop);
  return Number.isSafeInteger(index) && index >= 0 && index < 4294967295;
}

const runsAllResultTargets = new WeakMap();

const MAX_LANES = 32;
const MAX_LANE_STAGES = 16;
const MAX_LANE_STAGE_COUNT = 64;
const MAX_LANE_SPEC_BYTES = 64 * 1024;
const MAX_LANE_TASK_BYTES = 1024 * 1024;
const MAX_LANE_PATH_BYTES = 32 * 1024;
const MAX_LANE_BOARD_TEXT_BYTES = 256;
const LANE_PATH_FIELDS = new Set(["cwd", "output", "sessionDir"]);

function runsAllKeyAccessError(prop) {
  return new Error("Cannot read runs.all result property '" + prop + "'. runs.all resolves to an ordered array, not a key map. Use results[0], array destructuring, or results.map((result) => result.output), not results." + prop + ".");
}

function wrapRunsAllResults(results, keys) {
  const keySet = new Set(keys);
  const proxy = new Proxy(results, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop === "then" || prop === "toJSON") return undefined;
      if (prop in target || isArrayIndexProperty(prop)) return Reflect.get(target, prop, receiver);
      if (keySet.has(prop)) throw runsAllKeyAccessError(prop);
      throw runsAllKeyAccessError(prop);
    },
  });
  runsAllResultTargets.set(proxy, results);
  return proxy;
}

function laneByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function laneBoardText(value) {
  if (typeof value !== "string" || !value) return undefined;
  if (laneByteLength(value) <= MAX_LANE_BOARD_TEXT_BYTES) return value;
  const bytes = new TextEncoder().encode(value).subarray(0, MAX_LANE_BOARD_TEXT_BYTES - 3);
  return new TextDecoder().decode(bytes) + "...";
}

function laneBoardPath(value) {
  if (typeof value !== "string" || !value || laneByteLength(value) > MAX_LANE_BOARD_TEXT_BYTES) return undefined;
  return value;
}

function validateLaneStageBounds(params, label) {
  if (typeof params.task === "string" && laneByteLength(params.task) > MAX_LANE_TASK_BYTES) throw new Error(label + " task exceeds 1 MiB when UTF-8 encoded.");
  for (const field of LANE_PATH_FIELDS) if (typeof params[field] === "string" && laneByteLength(params[field]) > MAX_LANE_PATH_BYTES) throw new Error(label + " " + field + " exceeds 32 KiB when UTF-8 encoded.");
}

function validateLaneKey(value, owner) {
  if (typeof value !== "string" || !runKeyPattern.test(value)) throw new Error(owner + " key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
  return value;
}

function laneStageParams(stage, previous) {
  const resume = stage.resume;
  const params = { ...stage.params };
  if (resume !== "previous") return params;
  if (!previous || typeof previous.runId !== "string" || !previous.runId.trim()) return undefined;
  return { ...params, resume: previous.runId.trim() };
}

function laneStageVerdict(result) {
  const structured = result && typeof result === "object" && !Array.isArray(result) ? result.structuredOutput : undefined;
  const verdict = structured && typeof structured === "object" && !Array.isArray(structured) ? structured.verdict : undefined;
  return typeof verdict === "string" && verdict.trim() ? laneBoardText(verdict.trim()) : undefined;
}

function laneStageIsBlocked(result) {
  const structured = result && typeof result === "object" && !Array.isArray(result) ? result.structuredOutput : undefined;
  return structured && typeof structured === "object" && !Array.isArray(structured) && structured.verdict === "blocked";
}

function laneStageRecord(stageKey, child, forcedState) {
  const result = child && typeof child === "object" && !Array.isArray(child) ? child : undefined;
  const ok = result?.ok === true;
  const verdict = laneStageVerdict(result);
  const blocked = laneStageIsBlocked(result);
  const state = forcedState ?? (result?.state === "running" ? "running" : result?.stopped ? "stopped" : result?.detached ? "detached" : ok ? blocked ? "blocked" : "completed" : "failed");
  const error = state !== "completed" && state !== "running"
    ? state === "blocked" && blocked
      ? "Stage returned a blocked verdict."
      : typeof result?.error === "string"
        ? result.error
        : typeof result?.output === "string"
          ? result.output
          : "Stage did not complete successfully."
    : undefined;
  return {
    key: stageKey,
    ...(typeof result?.runId === "string" && result.runId.trim() ? { runId: laneBoardText(result.runId.trim()) } : {}),
    ...(result ? { ok } : {}),
    state,
    ...(typeof result?.outputReference === "string" ? (laneBoardPath(result.outputReference) ? { outputReference: laneBoardPath(result.outputReference) } : {}) : {}),
    ...(verdict ? { verdict } : {}),
    ...(error ? { error: laneBoardText(error) } : {}),
  };
}

function laneFailure(stageKey, error) {
  const text = error instanceof Error ? error.message : String(error);
  return { key: stageKey, ok: false, output: text, error: text, artifactPaths: [] };
}

function runCollected(key, params, observe, generatedLaneKey) {
  validateRunCall(key, params, "runs.lanes stage", runFingerprints);
  const launched = runHostCall(key, params, true, undefined, generatedLaneKey);
  observe([{ key, operation: "run", callId: launched.callId }]);
  return launched.promise.then(decorateWorkflowChildResult);
}

function validateLaneSpecs(laneSpecs) {
  if (!Array.isArray(laneSpecs)) throw new Error("runs.lanes(lanes) requires an array.");
  if (laneSpecs.length === 0) throw new Error("runs.lanes(lanes) requires at least one lane.");
  if (laneSpecs.length > MAX_LANES) throw new Error("runs.lanes supports at most " + MAX_LANES + " lanes.");
  assertJsonValue(laneSpecs, "runs.lanes lanes");
  if (laneByteLength(stableRunJson(laneSpecs)) > MAX_LANE_SPEC_BYTES) throw new Error("runs.lanes canonical JSON exceeds 64 KiB.");
  const generatedKeys = new Set();
  const validationFingerprints = new Map();
  let stageCount = 0;
  const normalized = [];
  for (let laneIndex = 0; laneIndex < laneSpecs.length; laneIndex++) {
    const lane = laneSpecs[laneIndex];
    const laneLabel = "runs.lanes lane " + laneIndex;
    if (!lane || typeof lane !== "object" || Array.isArray(lane)) throw new Error(laneLabel + " must be an object.");
    const laneFields = Object.keys(lane);
    if (laneFields.some((field) => field !== "key" && field !== "stages")) throw new Error(laneLabel + " contains unsupported fields.");
    const laneKey = validateLaneKey(lane.key, laneLabel);
    if (!Array.isArray(lane.stages) || lane.stages.length === 0) throw new Error(laneLabel + " stages must contain at least one stage.");
    if (lane.stages.length > MAX_LANE_STAGES) throw new Error(laneLabel + " supports at most " + MAX_LANE_STAGES + " stages.");
    const stageKeys = new Set();
    const stages = [];
    for (let stageIndex = 0; stageIndex < lane.stages.length; stageIndex++) {
      stageCount++;
      if (stageCount > MAX_LANE_STAGE_COUNT) throw new Error("runs.lanes supports at most " + MAX_LANE_STAGE_COUNT + " total stages.");
      const stage = lane.stages[stageIndex];
      const stageLabel = laneLabel + " stage " + stageIndex;
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error(stageLabel + " must be an object.");
      const stageKey = validateLaneKey(stage.key, stageLabel);
      if (stageKeys.has(stageKey)) throw new Error(laneLabel + " contains duplicate stage key '" + stageKey + "'.");
      stageKeys.add(stageKey);
      const generatedKey = laneKey + "." + stageKey;
      validateLaneKey(generatedKey, stageLabel + " generated");
      if (generatedKeys.has(generatedKey)) throw new Error("runs.lanes generated child key '" + generatedKey + "' is duplicated.");
      generatedKeys.add(generatedKey);
      const resume = stage.resume;
      if (resume !== undefined && resume !== "previous") {
        if (stageIndex === 0 && typeof resume === "string") {
          throw new Error(stageLabel + " cannot resume a retained run id in runs.lanes; use runs.run(key, { resume: id }) outside lanes, or start the lane with an agent stage and use resume: \"previous\" later.");
        }
        throw new Error(stageLabel + " resume must be 'previous'.");
      }
      if (stageIndex === 0 && resume === "previous") throw new Error(stageLabel + " cannot resume previous without a predecessor stage.");
      const { key: _stageKey, resume: _resume, ...params } = stage;
      const validationParams = resume === "previous" ? { ...params, resume: "retained-run-placeholder" } : params;
      validateLaneStageBounds(validationParams, stageLabel);
      validateRunCall(generatedKey, validationParams, stageLabel, validationFingerprints);
      const existingFingerprint = runFingerprints.get(generatedKey);
      if (existingFingerprint !== undefined && (resume === "previous" || existingFingerprint !== stableRunJson(canonicalRunParams(params)))) {
        throw new Error("runs.lanes generated child key '" + generatedKey + "' is already used with incompatible launch params.");
      }
      stages.push({ key: stageKey, generatedKey, resume, params });
    }
    normalized.push({ key: laneKey, stages });
  }
  return normalized;
}

function runLane(lane, firstResult, observe) {
  const records = [];
  const appendSkipped = (start) => {
    for (let index = start; index < lane.stages.length; index++) records.push({ key: lane.stages[index].key, state: "skipped" });
  };
  const finish = (state, failedStage) => ({ key: lane.key, state, ...(failedStage ? { failedStage } : {}), stages: records });
  const visit = (index, previous) => {
    if (index >= lane.stages.length) return Promise.resolve(finish("complete"));
    const stage = lane.stages[index];
    if (index === 0) {
      const record = laneStageRecord(stage.key, previous);
      records.push(record);
      if (record.state !== "completed") {
        appendSkipped(index + 1);
        return Promise.resolve(finish("blocked", stage.key));
      }
      return visit(index + 1, previous);
    }
    if (stage.resume === "previous" && (!previous || typeof previous.runId !== "string" || !previous.runId.trim())) {
      records.push({ key: stage.key, state: "blocked", error: "Previous stage did not return a retained run id." });
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    if (!previous || previous.ok !== true || laneStageIsBlocked(previous)) {
      records.push({ key: stage.key, state: "blocked", error: "Previous stage did not complete successfully." });
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    const params = laneStageParams(stage, previous);
    if (!params) {
      records.push({ key: stage.key, state: "blocked", error: "Previous stage did not return a retained run id." });
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    let launched;
    try {
      launched = runCollected(stage.generatedKey, params, observe, lane.key);
    } catch (error) {
      const failed = laneFailure(stage.generatedKey, error);
      records.push(laneStageRecord(stage.key, failed));
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    return launched.then((result) => {
      const record = laneStageRecord(stage.key, result);
      records.push(record);
      if (record.state === "completed") return visit(index + 1, result);
      appendSkipped(index + 1);
      return finish("blocked", stage.key);
    }, (error) => {
      const failed = laneFailure(stage.generatedKey, error);
      records.push(laneStageRecord(stage.key, failed));
      appendSkipped(index + 1);
      return finish("blocked", stage.key);
    });
  };
  return visit(0, firstResult);
}

function workflowPlanStringMetadata(params) {
  return {
    ...(typeof params.phase === "string" && params.phase.trim() ? { phase: params.phase.trim() } : {}),
    ...(typeof params.label === "string" && params.label.trim() ? { label: params.label.trim() } : {}),
    ...(typeof params.agent === "string" && params.agent.trim() ? { agent: params.agent.trim() } : {}),
  };
}

function runLanes(laneSpecs) {
  const lanes = validateLaneSpecs(laneSpecs);
  parentPort.postMessage({ type: "lanePlan", lanes: lanes.map((lane) => ({
    key: lane.key,
    stages: lane.stages.map((stage) => ({
      key: stage.key,
      generatedKey: stage.generatedKey,
      ...workflowPlanStringMetadata(stage.params),
      ...(typeof stage.params.as === "string" && stage.params.as.trim() ? { outputName: stage.params.as.trim() } : {}),
      ...(stage.params.outputSchema ? { structured: true } : {}),
    })),
  })) });
  const firstItems = lanes.map((lane) => {
    const first = lane.stages[0];
    return { key: first.generatedKey, ...first.params };
  });
  // Share the runs.all batch launcher while allowing each lane to advance independently.
  const firstBatch = launchRunsAll(firstItems, lanes.map((lane) => lane.key));
  const firstResults = firstBatch.launched.map(({ promise }) => promise.then(decorateWorkflowChildResult));
  let trackedAggregate;
  const observe = (observations) => trackRunObservation(observations, trackedAggregate);
  const laneAggregate = Promise.all(lanes.map((lane, index) => firstResults[index].then(
    (result) => runLane(lane, result, observe),
    (error) => runLane(lane, laneFailure(lane.stages[0].generatedKey, error), observe),
  )));
  trackedAggregate = trackRunObservation(firstBatch.launched.map(({ key, callId }) => ({ key, operation: "run", callId })), laneAggregate);
  return trackedAggregate;
}

function formatRef(result) {
  if (!result || typeof result !== "object") throw new Error("runs.ref(result) requires a run result object.");
  const parts = ["run " + (result.key || "unknown")];
  if (result.runId) parts.push("id=" + String(result.runId).slice(0, 8));
  return "[" + parts.join("; ") + "]";
}

function formatChildResultString(result) {
  const output = typeof result?.output === "string" ? result.output.trim() : "";
  return output || formatRef(result);
}

function decorateWorkflowChildResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  Object.defineProperties(result, {
    toString: { value() { return formatChildResultString(this); }, enumerable: false, configurable: true },
  });
  return result;
}

let runFingerprints = new Map();

function validateExtensionBindings(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " extensionBindings must be a plain JSON object.");
  const keys = Object.keys(value);
  if (keys.length > 16) throw new Error(label + " extensionBindings supports at most 16 namespaces.");
  for (const key of keys) if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})\/[1-9][0-9]{0,8}$/.test(key)) throw new Error(label + " extensionBindings namespace '" + key + "' must use a package-like name followed by '/<positive-version>'.");
  assertJsonValue(value, label + " extensionBindings");
  let propertyCount = 0;
  function visit(entry, depth) {
    if (!entry || typeof entry !== "object") return;
    if (depth > 16) throw new Error(label + " extensionBindings exceeds the maximum nesting depth of 16.");
    if (Array.isArray(entry)) { for (const item of entry) visit(item, depth + 1); return; }
    for (const child of Object.values(entry)) {
      propertyCount++;
      if (propertyCount > 256) throw new Error(label + " extensionBindings exceeds 256 total properties.");
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
  if (new TextEncoder().encode(stableRunJson(value)).byteLength > 16384) throw new Error(label + " extensionBindings canonical JSON exceeds 16384 bytes.");
}

function validateLaneMetadata(value, label, workflowKey) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be a plain JSON object.");
  const fields = Object.keys(value);
  const allowed = ["version", "key", "mode", "sourceRef", "claims", "outputPaths"];
  const unknown = fields.filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(label + " has unsupported fields: " + unknown.join(", ") + ".");
  if (value.version !== 1) throw new Error(label + ".version must be 1.");
  if (typeof value.key !== "string" || !value.key.trim() || !runKeyPattern.test(value.key.trim())) throw new Error(label + ".key is invalid.");
  if (workflowKey !== undefined && value.key.trim() !== workflowKey) throw new Error(label + ".key must match workflow key '" + workflowKey + "'.");
  if (value.mode !== undefined && !["mutation", "review", "scout", "gate"].includes(value.mode)) throw new Error(label + ".mode is invalid.");
  const bounded = (entry, maxBytes) => typeof entry === "string" && entry.trim() && new TextEncoder().encode(entry.trim()).byteLength <= maxBytes && !/[\r\n\u0000]/.test(entry);
  if (value.sourceRef !== undefined && !bounded(value.sourceRef, 128)) throw new Error(label + ".sourceRef is invalid.");
  for (const [name, maxItems, maxLength] of [["claims", 20, 160], ["outputPaths", 10, 256]]) {
    if (value[name] === undefined) continue;
    if (!Array.isArray(value[name]) || value[name].length > maxItems || value[name].some((entry) => !bounded(entry, maxLength))) throw new Error(label + "." + name + " is invalid.");
  }
}

// Mirrors parseGateInput in src/runs/shared/acceptance.ts; the sandbox cannot import it.
function describeGateShapeError(gate) {
  const shape = "gate must be a non-empty command string or { command, output?: \"json\", schema?, timeoutMs? }.";
  if (typeof gate === "string") return gate.trim() ? undefined : shape;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return shape;
  for (const key of Object.keys(gate)) {
    if (!["command", "output", "schema", "timeoutMs"].includes(key)) return "gate." + key + " is not supported.";
  }
  if (typeof gate.command !== "string" || !gate.command.trim()) return shape;
  if (gate.output !== undefined && gate.output !== "json") return "gate.output must be \"json\" when present.";
  if (gate.schema !== undefined) {
    if (gate.output !== "json") return "gate.schema requires gate.output: \"json\".";
    if (!gate.schema || typeof gate.schema !== "object" || Array.isArray(gate.schema)) return "gate.schema must be a JSON Schema object.";
  }
  if (gate.timeoutMs !== undefined && (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 1)) return "gate.timeoutMs must be an integer >= 1.";
  return undefined;
}

function describeGateAcceptanceConflict(gate, acceptance) {
  const render = (value) => {
    let encoded;
    try {
      encoded = JSON.stringify(value) ?? String(value);
    } catch {
      encoded = String(value);
    }
    return encoded.length > 120 ? encoded.slice(0, 120) + "..." : encoded;
  };
  return " Both fields were present: gate=" + render(gate) + " acceptance=" + render(acceptance) + ".";
}

function validateRunCall(key, params, label, fingerprints) {
  if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error(label + " has an invalid key.");
  if (hostKeys.has(key)) throw new Error("Workflow key '" + key + "' is already used by runs.host.");
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(label + " requires a params object.");
  if (Object.prototype.hasOwnProperty.call(params, "action") || Object.prototype.hasOwnProperty.call(params, "workflowScript") || Object.prototype.hasOwnProperty.call(params, "globalConcurrencyLimit") || Object.prototype.hasOwnProperty.call(params, "maxSubagentSpawnsPerRun") || Object.prototype.hasOwnProperty.call(params, "tasks") || Object.prototype.hasOwnProperty.call(params, "chain") || Object.prototype.hasOwnProperty.call(params, "parallel") || Object.prototype.hasOwnProperty.call(params, "concurrency") || Object.prototype.hasOwnProperty.call(params, "chainDir")) {
    const hint = label === "runs.run" ? "; use runs.all(...) and JavaScript control flow for orchestration." : ".";
    throw new Error(label + " accepts one child via { agent, task } and execution controls only" + hint);
  }
  if (Object.prototype.hasOwnProperty.call(params, "clarify")) throw new Error(label + " does not support clarify UI.");
  if (params.worktree !== undefined && typeof params.worktree !== "boolean") throw new Error(label + " worktree must be true or false.");
  if (params.baseRef !== undefined && (typeof params.baseRef !== "string" || !validGitRef(params.baseRef))) throw new Error(label + " baseRef must be a valid Git ref: use HEAD or a supported named ref (for example, refs/heads/main). Full 40/64-character commit IDs and revision expressions are unsupported.");
  validateLaneMetadata(params.lane, label + " lane", key);
  if (params.gate !== undefined) {
    const gateError = describeGateShapeError(params.gate);
    if (gateError) throw new Error(label + " " + gateError);
  }
  if (params.gate !== undefined && params.acceptance !== undefined && params.acceptance !== false) throw new Error(label + " gate cannot be combined with acceptance; use one gate command or acceptance.verify." + describeGateAcceptanceConflict(params.gate, params.acceptance));
  if (params.gate !== undefined && params.resume !== undefined) throw new Error(label + " gate is not supported with retained resume.");
  if (params.extensionBindings !== undefined && params.resume !== undefined) throw new Error(label + " extensionBindings is not supported with retained resume; resume uses the original retained child binding.");
  if (params.resume !== undefined && typeof params.resume !== "string") {
    const reference = params.resume;
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error(label + " resume must be a retained run id or keyed workflow receipt reference.");
    const fields = Object.keys(reference);
    if (fields.some((field) => field !== "workflowRunId" && field !== "key" && field !== "latest")) throw new Error(label + " keyed resume contains unsupported fields.");
    if (typeof reference.workflowRunId !== "string" || !reference.workflowRunId.trim()) throw new Error(label + " keyed resume workflowRunId must be non-empty.");
    if (typeof reference.key !== "string" || !runKeyPattern.test(reference.key)) throw new Error(label + " keyed resume key is invalid.");
    if (reference.latest !== true) throw new Error(label + " keyed resume requires latest: true.");
  }
  if (typeof params.resume === "string" && !params.resume.trim()) throw new Error(label + " resume must be a non-empty retained run id.");
  if (params.resume !== undefined && params.agent !== undefined) throw new Error(label + " resume and agent are mutually exclusive.");
  if (params.resume !== undefined && (typeof params.task !== "string" || !params.task.trim())) throw new Error(label + " resume requires a non-empty task follow-up.");
  validateExtensionBindings(params.extensionBindings, label);
  assertJsonValue(params, label + " params");
  const fingerprint = stableRunJson(canonicalRunParams(params));
  const existing = fingerprints.get(key);
  if (existing !== undefined && existing !== fingerprint) throw new Error("Duplicate workflow key '" + key + "' used with incompatible launch params.");
  fingerprints.set(key, fingerprint);
}

const hostKeys = new Set();

function validateHostCommand(key, params) {
  validateLaneKey(key, "runs.host");
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("runs.host('" + key + "') params must be an object.");
  const allowed = new Set(["kind", "command", "timeoutMs", "output", "role", "provider"]);
  const unknown = Object.keys(params).filter((field) => !allowed.has(field));
  if (unknown.length) {
    const cwdHint = unknown.includes("cwd")
      ? " The host step does not accept per-step cwd; commands and relative output paths use the workflow cwd. Set cwd on the outer subagent request, or put a trusted directory change in command (for example, 'cd /path/to/worktree && npm test')."
      : "";
    throw new Error("runs.host('" + key + "') params have unsupported fields: " + unknown.join(", ") + "." + cwdHint);
  }
  if (params.kind !== "command") throw new Error("runs.host('" + key + "') kind must be 'command'.");
  if (typeof params.command !== "string" || !params.command.trim() || params.command.includes("\u0000") || new TextEncoder().encode(params.command.trim()).byteLength > 16384) throw new Error("runs.host('" + key + "') command must be a non-empty string of at most 16384 bytes without NUL.");
  if (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 86400000) throw new Error("runs.host('" + key + "') timeoutMs must be an integer from 1 to 86400000.");
  if (params.output !== undefined && (typeof params.output !== "string" || !params.output.trim() || /^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(params.output) || /[\u0000-\u001f\u007f]/.test(params.output) || new TextEncoder().encode(params.output.trim()).byteLength > 240)) throw new Error("runs.host('" + key + "') output must be a bounded relative path without traversal or control characters.");
  if (params.role !== undefined && params.role !== "ci" && params.role !== "gate") throw new Error("runs.host('" + key + "') role must be 'ci' or 'gate'.");
  if (params.provider !== undefined && (typeof params.provider !== "string" || !params.provider.trim() || /[\r\n\u0000]/.test(params.provider) || new TextEncoder().encode(params.provider.trim()).byteLength > 64)) throw new Error("runs.host('" + key + "') provider must be a non-empty single-line string of at most 64 bytes.");
  assertJsonValue(params, "runs.host('" + key + "') params");
  if (hostKeys.has(key) || runFingerprints.has(key)) throw new Error("Workflow key '" + key + "' is already in use.");
  if (hostKeys.size >= 32) throw new Error("workflowScript supports at most 32 runs.host calls.");
  hostKeys.add(key);
}

const RUNS_ALL_PERMISSIVE_WARNING = "runs.all received runs.run(...) launch promise(s) or thenable(s). Those children were already launched individually, so runs.all cannot apply batch fingerprint validation, batch grouping in the fleet view, or collectFailure semantics; a failed child will throw at the runs.all boundary instead of returning as { ok: false }. To get full runs.all semantics, pass config objects: runs.all(items.map((item) => ({ key: item.key, agent: item.agent, task: item.task }))).";

function runsAllItemThenableInfo(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (typeof item.then !== "function") return null;
  const tracker = promiseObservationTracker(item);
  const observation = tracker && Array.isArray(tracker.observations) ? tracker.observations.find((entry) => entry && entry.operation === "run") : undefined;
  return {
    key: observation && typeof observation.key === "string" ? observation.key : ("runs.all[" + index + "]"),
    callId: observation && typeof observation.callId === "number" ? observation.callId : null,
    promise: item,
  };
}

let warnedPermissiveRunsAll = false;

function launchRunsAll(items, generatedLaneKeys) {
  if (!Array.isArray(items)) throw new Error("runs.all(items) requires an array.");
  const anyThenable = items.some((item, index) => runsAllItemThenableInfo(item, index) !== null);
  if (anyThenable) return launchRunsAllPermissive(items);
  const fingerprints = new Map(runFingerprints);
  const calls = [];
  for (let index = 0; index < items.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(items, index)) throw new Error("runs.all items must not contain sparse entries.");
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("runs.all item " + index + " must be an object.");
    const { key, ...params } = item;
    validateRunCall(key, params, "runs.all item " + index, fingerprints);
    calls.push({ key, params });
  }
  runFingerprints = fingerprints;
  const batch = { id: "batch-" + (++nextCallId), calls };
  const launched = calls.map(({ key, params }, index) => runHostCall(key, params, true, batch, generatedLaneKeys?.[index]));
  return { calls, launched };
}

function launchRunsAllPermissive(items) {
  if (!warnedPermissiveRunsAll) {
    warnedPermissiveRunsAll = true;
    try { capturedConsole.warn(RUNS_ALL_PERMISSIVE_WARNING); } catch { /* console emission is best-effort */ }
  }
  const fingerprints = new Map(runFingerprints);
  const calls = [];
  const launched = [];
  for (let index = 0; index < items.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(items, index)) throw new Error("runs.all items must not contain sparse entries.");
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("runs.all item " + index + " must be an object or a runs.run(...) launch promise.");
    const thenable = runsAllItemThenableInfo(item, index);
    if (thenable) {
      calls.push({ key: thenable.key, params: {} });
      launched.push(thenable);
      continue;
    }
    const { key, ...params } = item;
    validateRunCall(key, params, "runs.all item " + index, fingerprints);
    calls.push({ key, params });
    launched.push(null);
  }
  runFingerprints = fingerprints;
  return { calls, launched: launched.map((entry, index) => entry ?? runHostCall(calls[index].key, calls[index].params, false, undefined)) };
}

const runs = Object.freeze({
  run(key, params) {
    validateRunCall(key, params, "runs.run", runFingerprints);
    const launched = runHostCall(key, params, false);
    return trackRunObservation([{ key, operation: "run", callId: launched.callId }], launched.promise.then(decorateWorkflowChildResult));
  },
  all(items) {
    const { calls, launched } = launchRunsAll(items);
    return trackRunObservation(launched.map(({ key, callId }) => ({ key, operation: "run", callId })), trackPromiseCombinator(launched.map(({ promise }) => promise), (values) => Promise.all(values).then((results) => wrapRunsAllResults(results.map(decorateWorkflowChildResult), calls.map(({ key }) => key)))));
  },
  lanes(laneSpecs) {
    return runLanes(laneSpecs);
  },
  host(key, params) {
    validateHostCommand(key, params);
    return hostCall("host", { key, params }, { key, operation: "host" });
  },
  steer(key, message, options = {}) {
    if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error("runs.steer has an invalid key.");
    if (typeof message !== "string" || !message.trim()) throw new Error("runs.steer message must be a non-empty string.");
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("runs.steer options must be an object.");
    const allowed = new Set(["mode", "index", "ackTimeoutMs"]);
    for (const option of Object.keys(options)) if (!allowed.has(option)) throw new Error("runs.steer options contain unsupported field '" + option + "'.");
    if (options.mode !== undefined && options.mode !== "steer" && options.mode !== "follow_up" && options.mode !== "auto") throw new Error("runs.steer mode must be 'steer', 'follow_up', or 'auto'.");
    if (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0 || options.index > 1000000)) throw new Error("runs.steer index must be an integer between 0 and 1000000.");
    if (options.ackTimeoutMs !== undefined && (!Number.isInteger(options.ackTimeoutMs) || options.ackTimeoutMs < 1)) throw new Error("runs.steer ackTimeoutMs must be a positive integer.");
    return hostCall("steer", { key, message: message.trim(), options }, { key, operation: "steer" });
  },
  status(keyOrRunId) { return hostCall("status", { keyOrRunId }); },
  ref: formatRef,
  refs(results) {
    if (!Array.isArray(results)) throw new Error("runs.refs(results) requires an array.");
    return results.map(formatRef).join("\n");
  },
});

function validateStateKey(key) {
  if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
  return key;
}

const state = Object.freeze({
  get(key) { return hostCall("state.get", { key: validateStateKey(key) }); },
  set(key, value) {
    const validKey = validateStateKey(key);
    assertJsonValue(value, "state.set('" + validKey + "') value");
    return hostCall("state.set", { key: validKey, value });
  },
});

let contextObjectPrototype;

const capturedConsole = Object.freeze(Object.fromEntries(
  ["log", "info", "warn", "error"].map((level) => [level, (...args) => {
    parentPort.postMessage({ type: "console", level, text: args.map((value) => typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 })).join(" ") });
  }]),
));

function formatWorkflowScriptSyntaxError(error) {
  const details = formatWorkflowScriptError(error);
  return [
    "workflowScript must be valid JavaScript.",
    "If task text contains Markdown fences or backticks, use an array joined with \"\\n\" or escaped strings instead of a raw backtick template literal.",
    "",
    "Original SyntaxError:",
    details,
  ].join("\n");
}

function formatWorkflowScriptError(error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  const stack = error && typeof error.stack === "string" ? error.stack : "";
  if (!stack) return message;
  return stack.includes(message) ? stack : message + "\n" + stack;
}

function isSyntaxError(error) {
  return error instanceof SyntaxError || error?.name === "SyntaxError";
}

function postWorkflowError(error) {
  // Pre-run syntax and portability errors are tagged "validation" where the script is compiled;
  // anything reaching here was thrown while the script ran, including a runtime SyntaxError.
  const taggedKind = error && (typeof error === "object" || typeof error === "function") ? workflowErrorKinds.get(error) : undefined;
  parentPort.postMessage({ type: "error", error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error), errorKind: taggedKind ?? "script" });
}

process.on("unhandledRejection", postWorkflowError);

const NESTED_ASYNC_WORKFLOW_ERROR = "workflowScript validation failed before child launch; no children launched. workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains so workflows stay portable across Node and Bun. Parallel plus sequential rewrite: const a = runs.run(\"a\", { agent: \"worker\", task: \"A\" }); const writer = await runs.run(\"writer\", { agent: \"worker\", task: \"Write\" }); const review = await runs.run(\"review\", { agent: \"reviewer\", task: writer.output }); const [aResult] = await Promise.all([a]); return { a: aResult.output, issue: { writerRunId: writer.runId, reviewRunId: review.runId } };";
const AST_SCALAR_KEYS = new Set(["type", "start", "end"]);

function assertPortableWorkflowScript(source) {
  const wrapped = "(async () => {\n" + source + "\n})()";
  let ast;
  try {
    ast = parse(wrapped, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    // The wrapper adds one line before the script; report the script's own line.
    if (isSyntaxError(error) && typeof error.message === "string") {
      const message = error.message.replace(/\((\d+):(\d+)\)$/, (_match, line, column) => "(" + Math.max(1, Number(line) - 1) + ":" + column + ")");
      if (typeof error.stack === "string") error.stack = error.stack.replace(error.message, message);
      error.message = message;
    }
    throw error;
  }
  const wrapper = workflowWrapperFunction(ast);
  walkWorkflowAst(wrapper.body, wrapper);
}

function workflowWrapperFunction(ast) {
  const wrapper = ast.body?.[0]?.expression?.callee;
  if (!wrapper || wrapper.type !== "ArrowFunctionExpression") throw new Error("workflowScript wrapper parse invariant failed.");
  return wrapper;
}

function isAsyncFunctionNode(node) {
  return node.async === true && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression");
}

function walkWorkflowAst(node, allowedAsyncFunction) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkWorkflowAst(item, allowedAsyncFunction);
    return;
  }
  if (node !== allowedAsyncFunction && isAsyncFunctionNode(node)) {
    throw new Error(NESTED_ASYNC_WORKFLOW_ERROR);
  }
  for (const [key, child] of Object.entries(node)) {
    if (AST_SCALAR_KEYS.has(key)) continue;
    walkWorkflowAst(child, allowedAsyncFunction);
  }
}

function assertJsonValue(value, path = "emit", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(path + " must contain only finite JSON numbers.");
    return;
  }
  if (typeof value !== "object") throw new Error(path + " must be a JSON value; received " + typeof value + ".");
  if (seen.has(value)) throw new Error(path + " must not contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(path + " must not contain sparse array entries.");
      assertJsonValue(value[index], path + "[" + index + "]", seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype && prototype !== contextObjectPrototype) throw new Error(path + " must contain only plain JSON objects.");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(path + " must not contain symbol keys.");
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, path + "." + key, seen);
  }
  seen.delete(value);
}

function isPlainWorkflowObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype || prototype === contextObjectPrototype;
}

function unwrapRunsAllResults(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  const runsAllTarget = runsAllResultTargets.get(value);
  const target = runsAllTarget || value;
  if (seen.has(target)) return seen.get(target);
  if (Array.isArray(target)) {
    const copy = [];
    seen.set(target, copy);
    let changed = !!runsAllTarget;
    for (let index = 0; index < target.length; index++) {
      copy[index] = unwrapRunsAllResults(target[index], seen);
      changed ||= copy[index] !== target[index];
    }
    return changed ? copy : target;
  }
  if (!isPlainWorkflowObject(target) || Object.getOwnPropertySymbols(target).length > 0) return target;
  let changed = false;
  const entries = Object.entries(target).map(([key, entry]) => {
    const unwrapped = unwrapRunsAllResults(entry, seen);
    changed ||= unwrapped !== entry;
    return [key, unwrapped];
  });
  return changed ? Object.fromEntries(entries) : target;
}

function omitUndefinedWorkflowValues(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const normalized = Array.isArray(value)
    ? value.map((entry) => entry === undefined ? null : omitUndefinedWorkflowValues(entry, seen))
    : isPlainWorkflowObject(value) && Object.getOwnPropertySymbols(value).length === 0
      ? Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => entry === undefined ? [] : [[key, omitUndefinedWorkflowValues(entry, seen)]]))
      : value;
  seen.delete(value);
  return normalized;
}

function deepFreezeWorkflowArgs(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreezeWorkflowArgs(entry);
  return Object.freeze(value);
}

parentPort.on("message", async (message) => {
  if (message.type === "response") {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.ok) entry.resolve(message.value);
    else {
      const error = new Error(message.error);
      if (message.errorKind === "child" || message.errorKind === "detached-child") workflowErrorKinds.set(error, message.errorKind);
      entry.reject(error);
    }
    return;
  }
  if (message.type !== "start") return;
  try {
    const sandbox = { runs, Promise: workflowPromise, emit(value) { const unwrapped = unwrapRunsAllResults(value); const emittedValue = unwrapped === undefined ? null : omitUndefinedWorkflowValues(unwrapped); assertJsonValue(emittedValue); parentPort.postMessage({ type: "emit", value: emittedValue }); }, console: capturedConsole };
    if (message.stateEnabled) sandbox.state = state;
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    contextObjectPrototype = vm.runInContext("Object.prototype", context);
    // Rebuild args inside the VM realm: a worker-realm object would expose the worker's unrestricted
    // Function through args.constructor.constructor, bypassing codeGeneration.strings: false.
    sandbox.args = deepFreezeWorkflowArgs(vm.runInContext("JSON.parse", context)(JSON.stringify(message.args ?? {})));
    let compiled;
    try {
      assertPortableWorkflowScript(message.script);
      compiled = new vm.Script("(async () => {\n" + message.script + "\n})()", { filename: "workflow-script.js", lineOffset: -1 });
    } catch (error) {
      parentPort.postMessage({ type: "error", errorKind: "validation", error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error) });
      return;
    }
    const nativePromisePrototype = vm.runInContext("(async () => {})().constructor.prototype", context);
    const nativeThenDescriptor = Object.getOwnPropertyDescriptor(nativePromisePrototype, "then");
    if (!nativeThenDescriptor || typeof nativeThenDescriptor.value !== "function") throw new Error("workflowScript could not inspect the VM Promise.prototype.then method.");
    const nativeThen = nativeThenDescriptor.value;
    let stopWorkflowPromiseHook;
    let value;
    try {
      // Some hosts freeze built-ins in every realm, which makes then read-only. The promise hooks
      // below still track observation, so skip the wrapper rather than fail every workflow.
      if (nativeThenDescriptor.configurable) Object.defineProperty(nativePromisePrototype, "then", {
        ...nativeThenDescriptor,
        value: function workflowPromiseThen(...args) {
          if (isDirectWorkflowScriptPromiseHandlerCall() || suppressNativePromiseConsumption > 0) {
            return withSuppressedNativePromiseConsumption(() => Reflect.apply(nativeThen, this, args));
          }
          return Reflect.apply(nativeThen, this, args);
        },
      });
      stopWorkflowPromiseHook = createWorkflowPromiseHook({
        before(promise) {
          activeNativePromises.push(promise);
        },
        after(promise) {
          const index = activeNativePromises.lastIndexOf(promise);
          if (index !== -1) activeNativePromises.splice(index, 1);
        },
        init(promise, parent) {
          const childTracker = nativePromiseTracker(promise);
          if (!parent) return;
          nativePromiseParents.set(promise, parent);
          const parentTracker = nativePromiseTracker(parent);
          addTrackerDependency(childTracker, parentTracker);
          const activePromise = activeNativePromises.at(-1);
          if (activePromise && activePromise !== parent) {
            addTrackerDependency(nativePromiseTracker(activePromise), parentTracker);
          } else if (!activePromise && suppressNativePromiseConsumption === 0) {
            markTrackedObservationsConsumed(parentTracker);
          }
        },
      });
      const workflowResultPromise = compiled.runInContext(context);
      topLevelWorkflowPromise = workflowResultPromise;
      markTrackedObservationsConsumed(nativePromiseTracker(workflowResultPromise));
      value = await workflowResultPromise;
    } finally {
      try {
        stopWorkflowPromiseHook?.();
      } finally {
        try {
          if (nativeThenDescriptor.configurable) Object.defineProperty(nativePromisePrototype, "then", nativeThenDescriptor);
        } finally {
          topLevelWorkflowPromise = undefined;
          activeNativePromises.length = 0;
          suppressNativePromiseConsumption = 0;
          nativePromiseTrackers = new WeakMap();
          nativePromiseParents = new WeakMap();
        }
      }
    }
    const persistedValue = value === undefined ? null : omitUndefinedWorkflowValues(value);
    try {
      assertJsonValue(persistedValue, "return");
    } catch (error) {
      parentPort.postMessage({ type: "error", errorKind: "return-serialization", errorPhase: "return-serialization", error: formatWorkflowScriptError(error) });
      return;
    }
    parentPort.postMessage({ type: "complete", value: persistedValue });
  } catch (error) {
    postWorkflowError(error);
  }
});
`;

// ../../../../tmp/vrtbuild/src/missions/store.ts
init_atomic_json();
init_utils();
var MISSION_STATUS_SET = new Set(MISSION_STATUSES);

// ../../../../tmp/vrtbuild/src/missions/workflow-state.ts
var MISSION_STATE_MAX_BYTES = 256 * 1024;

// ../../../../tmp/vrtbuild/src/runs/background/result-files.ts
var JSON_EXTENSION = ".json";
var MAX_JSON_FILE_STEM_BYTES = MAX_INDEX_SEGMENT_BYTES - Buffer.byteLength(JSON_EXTENSION, "utf-8");

// ../../../../tmp/vrtbuild/src/runs/background/stale-run-reconciler.ts
init_utils();
init_types();
init_model_info();

// ../../../../tmp/vrtbuild/src/runs/background/workflow-terminal-proof.ts
init_utils();

// ../../../../tmp/vrtbuild/src/runs/shared/async-status-projection.ts
init_display_text();
init_formatters();
init_model_info();

// ../../../../tmp/vrtbuild/src/workflows/workflow-preflight.ts
var WORKFLOW_PREFLIGHT_MAX_BYTES = 16 * 1024;

// ../../../../tmp/vrtbuild/src/runs/shared/workflow-graph.ts
init_settings();

// ../../../../tmp/vrtbuild/src/runs/shared/async-status-projection.ts
var DEFAULT_MAX_SERIALIZED_BYTES = 32 * 1024;

// ../../../../tmp/vrtbuild/src/runs/background/async-status.ts
init_lane_metadata();

// ../../../../tmp/vrtbuild/src/runs/shared/mutation-evidence.ts
var MAX_HASH_BYTES = 1024 * 1024;

// ../../../../tmp/vrtbuild/src/workflows/workflow-checklist.ts
init_model_info();
init_display_text();

// ../../../../tmp/vrtbuild/src/runs/background/async-status.ts
init_child_status();

// ../../../../tmp/vrtbuild/src/runs/background/subagent-wait.ts
init_types();
init_formatters();
init_utils();

// ../../../../tmp/vrtbuild/src/runs/background/completion-replay.ts
init_atomic_json();
var ARCHIVE_TEXT_LIMIT_BYTES = 64 * 1024;

// ../../../../tmp/vrtbuild/src/runs/background/wait-completions.ts
var STRUCTURED_OUTPUT_INLINE_LIMIT_BYTES = 4 * 1024;

// ../../../../tmp/vrtbuild/src/runs/background/async-resume.ts
init_types();
init_extension_bindings();
init_lane_metadata();
init_acceptance();
init_tool_budget();
init_capability_ceiling();

// ../../../../tmp/vrtbuild/src/runs/shared/worktree-lock.ts
init_file_lease();

// ../../../../tmp/vrtbuild/src/runs/shared/parallel-handoff.ts
init_atomic_json();

// ../../../../tmp/vrtbuild/src/runs/shared/worktree-setup-command.ts
init_owned_process_tree();

// ../../../../tmp/vrtbuild/src/runs/shared/worktree.ts
import * as path15 from "node:path";
init_utils();
var WORKTREE_AGENT_CWD_PLACEHOLDER = path15.join(path15.parse(process.cwd()).root, "__pi_subagents_worktree_cwd__");
var WORKTREE_COMMAND_OUTPUT_MAX_BYTES = 128 * 1024;
var WORKTRUNK_COMMAND = process.platform === "win32" ? "git" : "wt";
var WORKTRUNK_ARG_PREFIX = process.platform === "win32" ? ["wt"] : [];
var MACHINE_DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--line-prefix=", "--no-relative"];
var MACHINE_PATCH_OPTIONS = [...MACHINE_DIFF_OPTIONS, "--binary"];
var worktreeTurn = Promise.resolve();

// ../../../../tmp/vrtbuild/src/runs/shared/parallel-handoff.ts
init_lane_metadata();

// ../../../../tmp/vrtbuild/src/runs/background/async-resume.ts
init_thinking_ceiling();

// ../../../../tmp/vrtbuild/src/intercom/intercom-bridge.ts
init_utils();

// ../../../../tmp/vrtbuild/src/runs/background/resume-guidance.ts
init_model_resolution();

// ../../../../tmp/vrtbuild/src/runs/background/subagent-wait.ts
var DEFAULT_TIMEOUT_MS = 30 * 60 * 1e3;
var TRANSCRIPT_TAIL_BYTES = 128 * 1024;

// ../../../../tmp/vrtbuild/src/extension/declaration-pinning.ts
import { declarationsEqual, getCurrentSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";

// ../../../../tmp/vrtbuild/src/runs/background/auto-drain.ts
var DEFAULT_AUTO_DRAIN_TIMEOUT_MS = 30 * 60 * 1e3;

// ../../../../tmp/vrtbuild/src/runs/shared/subagent-prompt-runtime.ts
var STRUCTURED_OUTPUT_INSTRUCTIONS = [
  "This subagent step has a strict structured output contract.",
  "Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
  "Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step."
].join("\n");
var CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent, not the parent orchestrator.",
  "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
  "Ignore prior parent-only orchestration instructions in inherited conversation history.",
  "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
  "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text."
].join("\n");
var CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent with explicit fanout responsibility for this assigned task.",
  "The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
  "You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
  "Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
  "The maxSubagentDepth cap still applies and may block further fanout.",
  "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text."
].join("\n");
var PROMPT_CACHE_KEY_APIS = /* @__PURE__ */ new Set([
  "azure-openai-responses",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses"
]);
var isSystemMessage = (message2) => message2.role === "system";
var writtenBefore = (message2, forkedAt) => typeof message2.timestamp === "number" && message2.timestamp < forkedAt;
var promptText = (message2) => typeof message2?.content === "string" ? message2.content : (message2?.content ?? []).map((block) => block.text).join("");
function systemMessagesBefore(messages, forkedAt) {
  return messages.filter((message2) => isSystemMessage(message2) && writtenBefore(message2, forkedAt));
}
function modelBefore(messages, forkedAt) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message2 = messages[index];
    if (message2.role !== "assistant" || !writtenBefore(message2, forkedAt)) continue;
    if (typeof message2.provider !== "string" || typeof message2.api !== "string" || typeof message2.model !== "string") return void 0;
    return { provider: message2.provider, api: message2.api, model: message2.model };
  }
  return void 0;
}
var LOADOUT_SECTIONS = /* @__PURE__ */ new Set(["tools", "rules", "docs", "skills", "advertised_subagents", "mcp_servers", "project_context"]);
function forkInstructions(input) {
  const parent = getCurrentSystemMessage2(input.parent);
  const child = getCurrentSystemMessage2(input.child);
  const parts = [
    "The system prompt and tool list of this conversation are the parent session's, sent unchanged so this request reuses the parent's prompt cache. The instructions below are yours and take precedence over the parent's role.",
    `Tools you can call: ${getCurrentTools(input.child).map((tool) => tool.name).join(", ") || "none"}. Any other declared tool belongs to the parent session and fails if called.`
  ];
  const ownPrompt = promptText(getCurrentSystemMessage2(input.own));
  if (ownPrompt.length > 0) parts.push(ownPrompt);
  for (const [name, value] of Object.entries(child?.sections ?? {})) {
    if (!LOADOUT_SECTIONS.has(name) && value && parent?.sections?.[name] !== value) parts.push(value);
  }
  if (input.boundary) parts.push(input.boundary);
  return `<subagent_instructions>
${parts.join("\n\n")}
</subagent_instructions>`;
}
function prependText(message2, text2) {
  const content = message2.content;
  if (typeof content === "string") return { ...message2, content: `${text2}

${content}` };
  if (Array.isArray(content)) return { ...message2, content: [{ type: "text", text: text2 }, ...content] };
  return message2;
}
function projectForkRequest(messages, inherited, forkedAt, options = {}) {
  const own = (message2) => !writtenBefore(message2, forkedAt);
  if (inherited.length === 0 || !messages.some((message2) => !isSystemMessage(message2) && !own(message2))) {
    if (!options.boundary) return messages;
    const at2 = messages.findIndex((message2) => !isSystemMessage(message2));
    const section = { role: "system", content: "", sections: { subagent_boundary: `<subagent_boundary>
${options.boundary}
</subagent_boundary>` }, timestamp: forkedAt };
    return at2 === -1 ? [...messages, section] : [...messages.slice(0, at2), section, ...messages.slice(at2)];
  }
  const instructions = forkInstructions({ parent: inherited, child: messages, own: messages.filter((message2) => isSystemMessage(message2) && own(message2)), boundary: options.boundary });
  const parentTools = new Map(getCurrentTools(inherited).map((tool) => [tool.name, tool]));
  const childTools = getCurrentTools(messages).filter((tool) => {
    const parentTool = parentTools.get(tool.name);
    return !parentTool || !declarationsEqual2(parentTool, tool);
  });
  const redefined = childTools.filter((tool) => parentTools.has(tool.name)).map((tool) => ({ name: tool.name }));
  const sentInherited = messages.filter((message2) => isSystemMessage(message2) && !own(message2));
  const uncollapsed = sentInherited.length === inherited.length && sentInherited.every((message2, index) => JSON.stringify(message2) === JSON.stringify(inherited[index]));
  const conversation = messages.filter((message2) => !isSystemMessage(message2));
  const head = getCurrentSystemMessage2(inherited);
  const next = uncollapsed ? messages.filter((message2) => !isSystemMessage(message2) || !own(message2)) : [...head ? [head] : [], ...conversation];
  const firstOwn = next.findIndex((message2) => !isSystemMessage(message2) && own(message2));
  const task2 = next.findIndex((message2) => message2.role === "user" && own(message2));
  const additions = [];
  if (childTools.length > 0) additions.push({ role: "system", content: "", ...redefined.length > 0 ? { toolsRemoved: redefined } : {}, toolsAdded: childTools, timestamp: forkedAt });
  if (task2 === -1) additions.push({ role: "system", content: "", sections: { subagent_instructions: instructions }, timestamp: forkedAt });
  else next[task2] = prependText(next[task2], instructions);
  const at = firstOwn === -1 ? next.length : firstOwn;
  return [...next.slice(0, at), ...additions, ...next.slice(at)];
}
function applyForkSessionAffinity(headers, model2, parentSessionId, parentModel) {
  const parent = parentSessionId?.trim();
  if (!headers || !parent || model2?.api !== "anthropic-messages") return;
  if (!parentModel || parentModel.provider !== model2.provider || parentModel.api !== model2.api || parentModel.model !== model2.id) return;
  const compat = model2.compat;
  if (!compat?.sendSessionAffinityHeaders) return;
  headers[compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity"] = parent;
}
function rewriteForkCacheProviderRequest(event, ctx, forkCacheKey) {
  const key = forkCacheKey?.trim();
  if (!key || !PROMPT_CACHE_KEY_APIS.has(ctx?.model?.api ?? "")) return void 0;
  if (!event || typeof event !== "object") return void 0;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return void 0;
  if (typeof payload.prompt_cache_key !== "string") return void 0;
  return { ...payload, prompt_cache_key: key };
}

// ../../../../tmp/vrtbuild/src/api/watchdog-runtime.ts
var EVIDENCE_TOOLS = ["read", "ls", "grep", "find"];
function createWatchdogRuntime() {
  const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
  return {
    async fork(input) {
      if (input.signal?.aborted) throw input.signal.reason;
      const resolver = createForkContextResolver(
        {
          getSessionFile: () => input.parent.getSessionFile(),
          getLeafId: () => input.anchorId ?? input.parent.getLeafId()
        },
        "fork",
        {
          runDirName: randomUUID2,
          openSession: (file, dir) => sdk.SessionManager.open(file, dir, input.cwd)
        }
      );
      await resolver.prepareSessionForIndex();
      const sessionFile = resolver.sessionFileForIndex();
      if (!sessionFile) throw new Error("The private inquiry requires a full fork.");
      const manager = sdk.SessionManager.open(sessionFile, void 0, input.cwd);
      const forkedAt = Date.parse(manager.getHeader()?.timestamp ?? "");
      if (!Number.isFinite(forkedAt)) throw new Error("Invalid private fork timestamp.");
      const messages = manager.buildSessionProjection().messages;
      const inherited = systemMessagesBefore(messages, Number.POSITIVE_INFINITY);
      if (inherited.length === 0) throw new Error("The parent has no inheritable system state.");
      const parentModel = modelBefore(messages, Number.POSITIVE_INFINITY);
      const cacheKey = deriveForkPromptCacheKey(input.parent.getSessionId());
      const resultFile = resolve10(input.resultFile);
      let active2 = false;
      let allowedWrite;
      let attemptError;
      let writeFailure;
      const evidence = input.profile?.kind === "read-only-evidence";
      const helperLimit = input.profile?.kind === "read-only-evidence" ? input.profile.maxHelperCalls ?? 10 : 0;
      let helpersAdmitted = 0;
      const admittedHelpers = /* @__PURE__ */ new Set();
      const writeResult = async (content) => {
        const file = await open(resultFile, constants2.O_WRONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
        try {
          if (!(await file.stat()).isFile()) throw new Error("The decision result must be a regular file.");
          await file.truncate(0);
          await file.writeFile(content, "utf8");
        } finally {
          await file.close();
        }
      };
      const singleResponse = {
        name: "pi-extension-utils:single-response",
        factory(pi) {
          const writer = sdk.createWriteToolDefinition(input.cwd, {
            operations: {
              mkdir: async (path16) => {
                if (resolve10(path16) !== dirname11(resultFile)) throw new Error("Invalid result directory.");
              },
              writeFile: async (path16, content) => {
                if (resolve10(path16) !== resultFile) throw new Error("Invalid result path.");
                await writeResult(content);
              }
            }
          });
          pi.registerTool({
            ...writer,
            async execute(callId, args2, signal, onUpdate, ctx) {
              try {
                if (!active2 || callId !== allowedWrite) throw new Error("No authorized result write.");
                return { ...await writer.execute(callId, args2, signal, onUpdate, ctx), terminate: true };
              } catch (error) {
                writeFailure = error;
                return { content: [{ type: "text", text: "Decision result write failed." }], details: void 0, isError: true, terminate: true };
              }
            }
          });
          pi.on("tool_call", (event) => {
            if (active2 && (event.toolCallId === allowedWrite || admittedHelpers.has(event.toolCallId))) return;
            return { block: true, reason: "Not an admitted private inquiry call." };
          });
          pi.on("message_end", (event) => {
            const message2 = event.message;
            if (message2.role !== "assistant" || message2.stopReason === "aborted" || message2.stopReason === "error") return;
            const calls = message2.content.filter((block) => block.type === "toolCall");
            const call = calls[0];
            if (calls.length === 1 && call?.name === "write" && message2.stopReason !== "length") {
              const args2 = call.arguments;
              if (args2 && typeof args2 === "object" && !Array.isArray(args2) && typeof args2.path === "string" && typeof args2.content === "string" && resolve10(input.cwd, args2.path) === resultFile) {
                allowedWrite = call.id;
                return;
              }
            }
            if (evidence && calls.length > 0 && message2.stopReason !== "length") {
              const helperOnly = calls.every((block) => EVIDENCE_TOOLS.includes(block.name));
              const keys = calls.map((block) => `${block.name}:${JSON.stringify(block.arguments)}`);
              const duplicate = new Set(keys).size !== keys.length;
              if (helperOnly && !duplicate && helpersAdmitted + calls.length <= helperLimit) {
                helpersAdmitted += calls.length;
                for (const block of calls) admittedHelpers.add(block.id);
                return;
              }
              attemptError = !helperOnly ? "A response must be either one write call to the designated result file, or only read/ls/grep/find evidence calls; nothing was executed." : duplicate ? "Duplicate evidence calls in one response are not allowed; nothing was executed." : `The evidence lookup budget (${helperLimit}) is exhausted or would be exceeded; nothing was executed. Write the result file now.`;
              return { message: { ...message2, content: message2.content.filter((block) => block.type !== "toolCall"), stopReason: "stop" } };
            }
            attemptError = "Expected exactly one write call to the designated decision result file, with string path and content.";
            return { message: { ...message2, content: message2.content.filter((block) => block.type !== "toolCall"), stopReason: "stop" } };
          });
        }
      };
      const projection = {
        name: "pi-extension-utils:private-fork",
        factory(pi) {
          pi.on("context", (event) => input.projectContext ? { messages: input.projectContext(event.messages) } : void 0);
          pi.on("context_with_system", (event) => ({
            messages: projectForkRequest(event.messages, inherited, forkedAt)
          }));
          pi.on("before_provider_headers", (event, ctx) => {
            applyForkSessionAffinity(event.headers, ctx.model, input.parent.getSessionId(), parentModel);
          });
          pi.on("before_provider_request", (event, ctx) => rewriteForkCacheProviderRequest(event, ctx, cacheKey));
        }
      };
      const child = await factory.create({
        cwd: input.cwd,
        agentDir: input.agentDir,
        projectTrusted: false,
        parentProviderRegistry: input.parentProviderRegistry,
        parentSessionFile: input.parent.getSessionFile(),
        storage: { kind: "file", sessionFile },
        model: input.model,
        autoRetryPolicy: input.retryPolicy,
        signal: input.signal,
        tools: evidence ? ["write", ...EVIDENCE_TOOLS] : ["write"],
        extensionPaths: [],
        ambientExtensions: false,
        hooks: [singleResponse, projection],
        noSkills: true,
        noContextFiles: true,
        systemPrompt: "",
        runtime: {
          cwd: input.cwd,
          fanoutChild: false,
          depth: 1,
          maxDepth: 1,
          waitTool: { enabled: false },
          fast: false
        }
      });
      const prompt = child.prompt;
      child.prompt = async (text2) => {
        if (active2) throw new Error("A private decision response is already running.");
        active2 = true;
        allowedWrite = void 0;
        attemptError = void 0;
        writeFailure = void 0;
        admittedHelpers.clear();
        try {
          await writeResult("{}");
          await prompt(text2);
          if (writeFailure) throw writeFailure;
        } finally {
          active2 = false;
        }
      };
      Object.defineProperty(child, "attemptError", { get: () => attemptError });
      Object.defineProperty(child, "helperCalls", { get: () => helpersAdmitted });
      return child;
    },
    dispose: () => factory.dispose()
  };
}
export {
  createWatchdogRuntime
};
