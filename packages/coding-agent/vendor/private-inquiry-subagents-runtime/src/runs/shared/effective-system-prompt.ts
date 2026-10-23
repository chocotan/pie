import type { AgentConfig } from "../../agents/agents.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { appendAgentRefinementOverlay } from "../../agents/agent-refinements.ts";
import { buildSkillInjection } from "../../agents/skills.ts";

export interface EffectiveSystemPromptInput {
	/** Agent as handed to the child, including runtime-declared overlays such as the Intercom bridge. */
	agent: AgentConfig;
	resolvedSkills: Parameters<typeof buildSkillInjection>[0];
	/** Directory that scopes memory and refinement lookups. */
	cwd: string;
}

function appendSection(prompt: string, section: string): string {
	return prompt ? `${prompt}\n\n${section}` : section;
}

/**
 * Child system prompt in the order preflight and every execution path hash:
 * base prompt, skills, memory, refinement overlay. The per-run output path goes
 * in the task message, so a child resumed with a new output path keeps the same
 * system prompt and its provider prompt cache. Runtime acceptance prose is
 * appended later and stays outside launch identity.
 */
export function buildEffectiveSystemPrompt(input: EffectiveSystemPromptInput): string {
	let prompt = input.agent.systemPrompt?.trim() ?? "";
	if (input.resolvedSkills.length > 0) prompt = appendSection(prompt, buildSkillInjection(input.resolvedSkills));
	const memoryInjection = buildAgentMemoryInjection(input.agent, input.cwd);
	if (memoryInjection) prompt = appendSection(prompt, memoryInjection);
	prompt = appendAgentRefinementOverlay(prompt, { cwd: input.cwd, agentName: input.agent.name });
	return prompt;
}
