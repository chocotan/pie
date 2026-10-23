import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createForkContextResolver } from "../shared/fork-context.ts";
import {
	createDefaultChildSessionFactory,
	type ChildHookExtension,
	type ChildSession,
	type ChildRetryPolicy,
	type ParentProviderRegistry,
} from "../runs/shared/child-session.ts";
import { deriveForkPromptCacheKey } from "../runs/shared/child-tool-plan.ts";
import {
	applyForkSessionAffinity,
	modelBefore,
	projectForkRequest,
	rewriteForkCacheProviderRequest,
	systemMessagesBefore,
} from "../runs/shared/subagent-prompt-runtime.ts";

export interface WatchdogForkInput {
	parent: sdk.ReadonlySessionManager;
	parentProviderRegistry: ParentProviderRegistry;
	cwd: string;
	agentDir: string;
	resultFile: string;
	model: string;
	/** Per-child retry policy: "disabled" (Continue) or "native" (Reflect). */
	retryPolicy: ChildRetryPolicy;
	signal?: AbortSignal;
	projectContext?: (messages: AgentMessage[]) => AgentMessage[];
	/** Restrict the fork to an explicit anchor entry instead of the current leaf. */
	anchorId?: string;
	/** Execution profile; default result-write-only. */
	profile?: WatchdogExecutionProfile;
}

/** Built-in read-only local evidence tools admitted by the evidence profile. */
const EVIDENCE_TOOLS = ["read", "ls", "grep", "find"] as const;

export type WatchdogExecutionProfile =
	| { kind: "result-write-only" }
	| {
			kind: "read-only-evidence";
			/** Executed helper calls allowed across the whole operation. Default 10. */
			maxHelperCalls?: number;
	  };

export function createWatchdogRuntime() {
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
	return {
		async fork(input: WatchdogForkInput): Promise<ChildSession> {
			if (input.signal?.aborted) throw input.signal.reason;
			const resolver = createForkContextResolver(
				{
					getSessionFile: () => input.parent.getSessionFile(),
					getLeafId: () => input.anchorId ?? input.parent.getLeafId(),
				},
				"fork",
				{
					runDirName: randomUUID,
					openSession: (file, dir) => sdk.SessionManager.open(file, dir, input.cwd),
				},
			);
			await resolver.prepareSessionForIndex();
			const sessionFile = resolver.sessionFileForIndex();
			if (!sessionFile) throw new Error("The private inquiry requires a full fork.");
			const manager = sdk.SessionManager.open(sessionFile, undefined, input.cwd);
			const forkedAt = Date.parse(manager.getHeader()?.timestamp ?? "");
			if (!Number.isFinite(forkedAt)) throw new Error("Invalid private fork timestamp.");
			const messages = manager.buildSessionProjection().messages;
			// This frozen projection predates child creation; a compaction checkpoint
			// can share the fork's millisecond and still belongs to the parent.
			const inherited = systemMessagesBefore(messages, Number.POSITIVE_INFINITY);
			if (inherited.length === 0) throw new Error("The parent has no inheritable system state.");
			const parentModel = modelBefore(messages, Number.POSITIVE_INFINITY);
			const cacheKey = deriveForkPromptCacheKey(input.parent.getSessionId());
			const resultFile = resolve(input.resultFile);
			let active = false;
			let allowedWrite: string | undefined;
			let attemptError: string | undefined;
			let writeFailure: unknown;
			const evidence = input.profile?.kind === "read-only-evidence";
			const helperLimit = input.profile?.kind === "read-only-evidence" ? input.profile.maxHelperCalls ?? 10 : 0;
			// One helper allowance for the whole operation, never reset per attempt.
			let helpersAdmitted = 0;
			const admittedHelpers = new Set<string>();
			const writeResult = async (content: string) => {
				const file = await open(resultFile, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					if (!(await file.stat()).isFile()) throw new Error("The decision result must be a regular file.");
					await file.truncate(0);
					await file.writeFile(content, "utf8");
				} finally {
					await file.close();
				}
			};
			const singleResponse: ChildHookExtension = {
				name: "pi-extension-utils:single-response",
				factory(pi) {
					const writer = sdk.createWriteToolDefinition(input.cwd, {
						operations: {
							mkdir: async (path) => {
								if (resolve(path) !== dirname(resultFile)) throw new Error("Invalid result directory.");
							},
							writeFile: async (path, content) => {
								if (resolve(path) !== resultFile) throw new Error("Invalid result path.");
								await writeResult(content);
							},
						},
					});
					pi.registerTool({
						...writer,
						async execute(callId, args, signal, onUpdate, ctx) {
							try {
								if (!active || callId !== allowedWrite) throw new Error("No authorized result write.");
								return { ...await writer.execute(callId, args, signal, onUpdate, ctx), terminate: true };
							} catch (error) {
								writeFailure = error;
								return { content: [{ type: "text", text: "Decision result write failed." }], details: undefined, isError: true, terminate: true };
							}
						},
					});
					// Defense in depth: only calls admitted at message_end ever execute.
					pi.on("tool_call", (event) => {
						if (active && (event.toolCallId === allowedWrite || admittedHelpers.has(event.toolCallId))) return;
						return { block: true, reason: "Not an admitted private inquiry call." };
					});
					pi.on("message_end", (event) => {
						const message = event.message;
						if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return;
						const calls = message.content.filter((block) => block.type === "toolCall");
						const call = calls[0];
						if (calls.length === 1 && call?.name === "write" && message.stopReason !== "length") {
							const args = call.arguments;
							if (args && typeof args === "object" && !Array.isArray(args) && typeof args.path === "string" && typeof args.content === "string" && resolve(input.cwd, args.path) === resultFile) {
								allowedWrite = call.id;
								return;
							}
						}
						if (evidence && calls.length > 0 && message.stopReason !== "length") {
							// A helper-only batch is admitted whole, or rejected whole before any effect.
							const helperOnly = calls.every((block) => (EVIDENCE_TOOLS as readonly string[]).includes(block.name));
							const keys = calls.map((block) => `${block.name}:${JSON.stringify(block.arguments)}`);
							const duplicate = new Set(keys).size !== keys.length;
							if (helperOnly && !duplicate && helpersAdmitted + calls.length <= helperLimit) {
								helpersAdmitted += calls.length;
								for (const block of calls) admittedHelpers.add(block.id);
								return;
							}
							attemptError = !helperOnly
								? "A response must be either one write call to the designated result file, or only read/ls/grep/find evidence calls; nothing was executed."
								: duplicate
									? "Duplicate evidence calls in one response are not allowed; nothing was executed."
									: `The evidence lookup budget (${helperLimit}) is exhausted or would be exceeded; nothing was executed. Write the result file now.`;
							return { message: { ...message, content: message.content.filter((block) => block.type !== "toolCall"), stopReason: "stop" } };
						}
						attemptError = "Expected exactly one write call to the designated decision result file, with string path and content.";
						return { message: { ...message, content: message.content.filter((block) => block.type !== "toolCall"), stopReason: "stop" } };
					});
				},
			};
			const projection: ChildHookExtension = {
				name: "pi-extension-utils:private-fork",
				factory(pi) {
					pi.on("context", (event) => input.projectContext
						? { messages: input.projectContext(event.messages) }
						: undefined);
					pi.on("context_with_system", (event) => ({
						messages: projectForkRequest(event.messages, inherited, forkedAt),
					}));
					pi.on("before_provider_headers", (event, ctx) => {
						applyForkSessionAffinity(event.headers, ctx.model, input.parent.getSessionId(), parentModel);
					});
					pi.on("before_provider_request", (event, ctx) =>
						rewriteForkCacheProviderRequest(event, ctx, cacheKey));
				},
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
					fast: false,
				},
			});
			const prompt = child.prompt;
			child.prompt = async (text) => {
				if (active) throw new Error("A private decision response is already running.");
				active = true;
				allowedWrite = undefined;
				attemptError = undefined;
				writeFailure = undefined;
				admittedHelpers.clear();
				try {
					await writeResult("{}");
					await prompt(text);
					if (writeFailure) throw writeFailure;
				} finally {
					active = false;
				}
			};
			Object.defineProperty(child, "attemptError", { get: () => attemptError });
			Object.defineProperty(child, "helperCalls", { get: () => helpersAdmitted });
			return child;
		},
		dispose: () => factory.dispose(),
	};
}
