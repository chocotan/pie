import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { normalizeQuestionParams, prepareQuestionArguments } from "./normalize-params.ts";
import { buildQuestionnaireResponse, buildToolResult } from "./response-envelope.ts";
import { runRpcQuestionnaire } from "./rpc-fallback.ts";
import { type QuestionnaireResult, QuestionParamsSchema } from "./types.ts";
import { validateQuestionnaire } from "./validate-questionnaire.ts";
import { QuestionnaireView } from "./view.ts";

export function createAskUserExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "ask_user_question",
			label: "Ask user",
			exposure: "model-only",
			executionMode: "sequential",
			description:
				"Ask 1–4 structured questions with 2–4 labeled options each. Every option has a description. Users can select options, select multiple with multiSelect, type a custom answer, or cancel. Option previews are supported for single-select questions. Use only when a concrete user decision is needed.",
			promptSnippet: "Ask the user structured questions when requirements need clarification",
			promptGuidelines: [
				"Group related questions into one ask_user_question call. Use the questions array, even for one question.",
				"Provide 2–4 options per question with concise labels and descriptions; do not author Other, Type something., or Next rows.",
				"Place a recommended option first with (Recommended) in its label. Previews are for single-select only.",
				"A cancelled questionnaire is not approval. Unavailable UI is not a user refusal; ask in ordinary text instead.",
			],
			parameters: QuestionParamsSchema,
			prepareArguments: prepareQuestionArguments,
			annotations: { destructiveHint: false, openWorldHint: false },
			async execute(_id, args, signal, _update, ctx) {
				signal?.throwIfAborted();
				const params = normalizeQuestionParams(args);
				const validation = validateQuestionnaire(params);
				if (!validation.ok)
					return {
						...buildToolResult(validation.message, { answers: [], cancelled: true, error: validation.error }),
						isError: true,
					};
				if (!ctx.hasUI)
					return {
						...buildToolResult(
							"UI is unavailable. The user did not see these questions; ask them in ordinary text instead.",
							{ answers: [], cancelled: true, error: "no_ui" },
						),
						isError: true,
					};
				pi.events.emit("pie.ask-user.prompt", params);
				pi.events.emit("pie.ask-user.blocked", { active: true });
				let removeAbort = () => {};
				try {
					let result: QuestionnaireResult | undefined;
					if (ctx.mode === "rpc") {
						result = await runRpcQuestionnaire(
							{
								select: (title, options) => ctx.ui.select(title, options, { signal }),
								input: (title, placeholder) => ctx.ui.input(title, placeholder, { signal }),
							},
							params,
						);
					} else {
						result = await ctx.ui.custom<QuestionnaireResult>(
							(tui, theme, keys, done) => {
								let settled = false;
								const finish = (value: QuestionnaireResult) => {
									if (settled) return;
									settled = true;
									removeAbort();
									done(value);
								};
								const abort = () => finish({ answers: [], cancelled: true });
								signal?.addEventListener("abort", abort, { once: true });
								removeAbort = () => signal?.removeEventListener("abort", abort);
								if (signal?.aborted) abort();
								return new QuestionnaireView(tui, theme, keys, params, finish);
							},
							{ blocked: { kind: "question", message: params.questions[0].question } },
						);
					}
					signal?.throwIfAborted();
					if (result === undefined)
						return {
							...buildToolResult(
								"This host cannot render the questionnaire. The user did not see the questions.",
								{ answers: [], cancelled: true, error: "no_custom_ui" },
							),
							isError: true,
						};
					return buildQuestionnaireResponse(result, params);
				} finally {
					removeAbort();
					pi.events.emit("pie.ask-user.blocked", { active: false });
				}
			},
			renderCall(args, theme) {
				return new Text(
					theme.fg("accent", `Ask user · ${args.questions.map((question) => question.header).join(", ")}`),
					0,
					0,
				);
			},
		});
		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user_question"));
		});
	};
}

export default createAskUserExtension();
