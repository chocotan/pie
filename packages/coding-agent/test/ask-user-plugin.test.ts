import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CURSOR_MARKER, getKeybindings, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createAskUserExtension } from "../src/extensions/ask-user/index.ts";
import { normalizeQuestionParams, prepareQuestionArguments } from "../src/extensions/ask-user/normalize-params.ts";
import { runRpcQuestionnaire } from "../src/extensions/ask-user/rpc-fallback.ts";
import { type QuestionParams, QuestionParamsSchema } from "../src/extensions/ask-user/types.ts";
import { validateQuestionnaire } from "../src/extensions/ask-user/validate-questionnaire.ts";
import { QuestionnaireView } from "../src/extensions/ask-user/view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getToolResult } from "./suite/harness.ts";

const params: QuestionParams = {
	questions: [
		{
			question: "Which approach?",
			header: "Approach",
			options: [
				{ label: "Small patch", description: "Reuse existing components", preview: "A small patch" },
				{ label: "Refactor", description: "Change the underlying structure" },
			],
		},
	],
};

describe("ported ask-user plugin", () => {
	it("keeps free-text input visible below long descriptions in an 80x24 terminal", () => {
		initTheme("dark", false);
		const keys = new KeybindingsManager();
		const previousKeys = getKeybindings();
		setKeybindings(keys);
		try {
			const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
			const questions: QuestionParams = {
				questions: [
					{
						...params.questions[0],
						options: params.questions[0].options.map((option) => ({
							...option,
							description: "Long description ".repeat(120),
							preview: undefined,
						})),
					},
				],
			};
			const done = vi.fn();
			const view = new QuestionnaireView(tui, theme, keys, questions, done);
			view.focused = true;
			expect(view.render(80)).toHaveLength(12);
			view.handleInput("\x1b[B");
			view.handleInput("\x1b[B");
			view.handleInput("\r");
			const lines = view.render(80);
			expect(lines.join("\n")).toContain("Your answer:");
			expect(lines.join("\n")).toContain(CURSOR_MARKER);
			view.handleInput("custom preference");
			view.handleInput("\r");
			expect(done).toHaveBeenCalledWith(
				expect.objectContaining({
					cancelled: false,
					answers: [expect.objectContaining({ kind: "custom", answer: "custom preference" })],
				}),
			);
		} finally {
			setKeybindings(previousKeys);
		}
	});
	it("supports a single question without ambiguous singular parameters", () => {
		expect(Compile(QuestionParamsSchema).Check(params)).toBe(true);
		expect(Compile(QuestionParamsSchema).Check({ question: "Which?", questions: [] })).toBe(false);
	});
	it("normalizes double-encoded model arguments before validating reserved rows", () => {
		const prepared = prepareQuestionArguments({
			questions: JSON.stringify([{ ...params.questions[0], options: JSON.stringify(params.questions[0].options) }]),
		});
		expect(Compile(QuestionParamsSchema).Check(prepared)).toBe(true);
		const invalid = normalizeQuestionParams({
			questions: [
				{
					...params.questions[0],
					options: [{ label: "Other\r", description: "Invalid reserved row" }, params.questions[0].options[1]],
				},
			],
		});
		expect(validateQuestionnaire(invalid)).toMatchObject({ ok: false, error: "reserved_label" });
		expect(validateQuestionnaire({ questions: [params.questions[0], params.questions[0]] })).toMatchObject({
			ok: false,
			error: "duplicate_question",
		});
	});
	it("walks native RPC dialogs and preserves the chosen preview", async () => {
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const result = await runRpcQuestionnaire({ select, input: vi.fn(async () => undefined) }, params);
		expect(result).toMatchObject({
			cancelled: false,
			answers: [{ kind: "option", answer: "Small patch", preview: "A small patch" }],
		});
		expect(select.mock.calls[0][0]).toContain("preview");
	});
	it("accepts multiple choices with an additional custom answer", async () => {
		const result = await runRpcQuestionnaire(
			{ select: vi.fn(async () => undefined), input: vi.fn(async () => "1,2; keep the public API") },
			{ questions: [{ ...params.questions[0], multiSelect: true }] },
		);
		expect(result.answers[0]).toMatchObject({
			kind: "multi",
			selected: ["Small patch", "Refactor"],
			answer: "keep the public API",
		});
	});
	it("returns to the choice list after a cancelled free-text follow-up", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options.at(-1))
			.mockImplementationOnce(async (_title: string, options: string[]) => options[1]);
		const result = await runRpcQuestionnaire({ select, input: async () => undefined }, params);
		expect(select).toHaveBeenCalledTimes(2);
		expect(result.answers[0].answer).toBe("Refactor");
	});
	it("registers the native tool and executes via the RPC UI contract", async () => {
		const harness = await createHarness({ extensionFactories: [createAskUserExtension()] });
		try {
			await harness.session.bindExtensions({
				mode: "rpc",
				uiContext: createTestUiContext({ select: async (_title, options) => options[0] }),
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("ask_user_question", params), { stopReason: "toolUse" }),
				fauxAssistantMessage("Proceed with the small patch"),
			]);
			await harness.session.prompt("Ask for a preference");
			const result = getToolResult(harness, "ask_user_question");
			expect(result.isError).toBe(false);
			expect(result.details).toMatchObject({ cancelled: false, answers: [{ answer: "Small patch" }] });
		} finally {
			harness.cleanup();
		}
	});
	it("uses the inline editor area instead of covering terminal messages", async () => {
		const harness = await createHarness({ extensionFactories: [createAskUserExtension()] });
		try {
			let customOptions: unknown;
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					custom: async <T>(_factory: unknown, options: unknown) => {
						customOptions = options;
						return { answers: [], cancelled: true } as T;
					},
				}),
			});
			const tool = harness.session.getToolDefinition("ask_user_question")!;
			const result = await tool.execute(
				"inline-question",
				params,
				undefined,
				undefined,
				harness.session.extensionRunner.createToolContext("inline-question", undefined),
			);
			expect(result.isError).toBeUndefined();
			expect(customOptions).toEqual({ blocked: { kind: "question", message: "Which approach?" } });
		} finally {
			harness.cleanup();
		}
	});
	it("does not equate unavailable UI with a user decline", async () => {
		const harness = await createHarness({ extensionFactories: [createAskUserExtension()] });
		try {
			await harness.session.bindExtensions({ mode: "print" });
			expect(harness.session.getActiveToolNames()).not.toContain("ask_user_question");
			const tool = harness.session.getToolDefinition("ask_user_question")!;
			const result = await tool.execute(
				"no-ui",
				params,
				undefined,
				undefined,
				harness.session.extensionRunner.createToolContext("no-ui", undefined),
			);
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({ error: "no_ui" });
		} finally {
			harness.cleanup();
		}
	});
});
