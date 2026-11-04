/**
 * pie service around the vendored superagent Engine.
 *
 * GitHub and Feishu watchers submit triggers. The Engine keeps authorization,
 * tickets, subscriptions, and reports. pie sessions only execute accepted work.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	Engine,
	ticketStage,
	type ChannelRef,
	type Ticket,
	type Trigger,
	type WorkerReport,
} from "./core/index.ts";
import { MemoryRepositories } from "./core/memory.ts";
import { settingsPolicy, SettingsSchema, type Settings } from "./policy.ts";
import type { Deployment } from "./types.ts";
import type { SetupProblem } from "./setup.ts";

export interface SessionPort {
	open(id: string, cwd: string, title: string, prompt: string): Promise<void>;
	deliver(id: string, text: string): Promise<void>;
	stop(id: string): Promise<void>;
}

export class RecordingSessions implements SessionPort {
	readonly prompts: string[] = [];
	readonly deliveries: string[] = [];
	async open(_id: string, _cwd: string, _title: string, prompt: string): Promise<void> {
		this.prompts.push(prompt);
	}
	async deliver(_id: string, text: string): Promise<void> {
		this.deliveries.push(text);
	}
	async stop(): Promise<void> {}
}

export interface ServiceOptions {
	stateDir: string;
	sessions?: SessionPort;
	settings?: Settings;
	deployment?: Deployment;
}

export class SuperagentService {
	readonly repo = new MemoryRepositories();
	readonly engine: Engine;
	readonly sessions: SessionPort;
	readonly replies: Array<{ channel: ChannelRef; text: string }> = [];
	settings: Settings;
	deployment?: Deployment;
	setupProblem?: SetupProblem;
	constructor(options: ServiceOptions) {
		mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
		this.sessions = options.sessions ?? new RecordingSessions();
		this.settings = options.settings ?? SettingsSchema.parse({});
		this.deployment = options.deployment;
		this.engine = new Engine({
			repo: this.repo,
			scope: { scope: () => ({ listened: true, observed: true }) },
			policy: () => settingsPolicy(this.settings, { scope: () => ({ listened: true, observed: true }) }),
			assessor: { request: () => {} },
			executor: {
				start: (ticket) => {
					void this.start(ticket);
				},
				deliver: (ticket) => {
					void this.deliver(ticket);
				},
				stop: (ticket) => {
					void this.sessions.stop(ticket.id);
				},
			},
			outbox: {
				send: (message) => {
					this.replies.push({ channel: message.channel, text: message.text });
				},
				status: () => undefined,
				withdraw: () => {},
			},
		});
	}

	receive(trigger: Trigger) {
		const result = this.engine.receive(trigger);
		this.engine.evaluateDue();
		return result;
	}

	accept(triggerId: string, title: string): Ticket {
		const decision = this.engine.decide(triggerId, {
			kind: "accept",
			title,
			scope: title,
			reason: { code: "explicitRouted" },
			acknowledgement: "已接单",
			name: "work",
		});
		const ticket = this.repo.tickets.get(decision.ticketId ?? "");
		if (!ticket) throw new Error("接单未创建工单");
		return ticket;
	}

	report(ticketId: string, report: WorkerReport): Ticket {
		return this.engine.report(ticketId, report);
	}

	private async start(ticket: Ticket): Promise<void> {
		const assignment = ticket.assignments.at(-1);
		if (!assignment) return;
		const cwd = join(ticket.execution?.directory ?? join(process.cwd(), "work"), ticket.id);
		mkdirSync(cwd, { recursive: true });
		await this.sessions.open(ticket.id, cwd, ticket.title, `Ticket ${ticket.id}: ${ticket.title}\nScope: ${ticket.mandate.scope}`);
		this.engine.assignmentStarted(ticket.id, assignment.id);
	}

	private async deliver(ticket: Ticket): Promise<void> {
		const current = this.repo.tickets.get(ticket.id);
		const assignment = current?.assignments.find((item) => item.state === "running");
		if (!current || !assignment) return;
		const ids = current.undelivered;
		for (const id of ids) {
			const input = current.inputs.find((item) => item.id === id);
			if (input) await this.sessions.deliver(current.id, JSON.stringify(input));
		}
		this.engine.inputsDelivered(current.id, assignment.id, ids);
	}

	async close(): Promise<void> {
		await this.sessions.stop("");
	}

overview() {
		return {
			setup: this.setupProblem ?? null,
			repository: this.deployment?.repository ?? "",
			paused: this.settings.paused,
			tickets: this.repo.tickets.list().map((ticket) => ({
				id: ticket.id,
				title: ticket.title,
				stage: ticketStage(ticket),
				updatedAt: ticket.updatedAt,
			})),
			threads: this.repo.threads.list().map((thread) => ({
				key: thread.key,
				pending: thread.pending.length,
				subscriptions: thread.subscriptions.length,
			})),
			replies: this.replies,
		};
	}
}

export type { AgentSession };
