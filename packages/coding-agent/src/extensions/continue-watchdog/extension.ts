import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { BACKGROUND_ACTIVITY_EVENT } from "../background/registry.ts";
import { registerMainAbortUnlock } from "./abort-outcome.ts";
import { registerMainUserAutoLock } from "./auto-lock.ts";
import { createMainCommands, handleUnlock, type MainCommandRuntime } from "./commands.ts";
import type { ContinueWatchdogConfig } from "./config.ts";
import type { LoadedConfig, LoadRuntimeConfigOptions } from "./config-loader.ts";
import { registerDecisionContextFolding } from "./context-fold.ts";
import type { LockDecisionController } from "./controller.ts";
import { createFatalExitAdapter, type FatalExitAdapter } from "./fatal-exit.ts";
import { createHubAttachmentInstance, getProcessObservableAgentHub, type ObservableAgentHub } from "./hub.ts";
import { getProcessDomainCoordinator, type ProcessDomainCoordinator } from "./process-domain.ts";
import { createDecisionRuntime, type RuntimeClock, type RuntimeControllerHolder } from "./runtime.ts";
import { projectBranchPreparation, projectCompactionPreparation } from "./summary-projection.ts";

/** Dependencies supplied only by focused lifecycle tests. */
export interface ContinueWatchdogExtensionOptions {
	readonly hub?: ObservableAgentHub;
	readonly processDomain?: ProcessDomainCoordinator;
	readonly fatalExit?: FatalExitAdapter;
	/** Optional lifecycle-test controller; normal installs load effective config. */
	readonly controller?: LockDecisionController;
	readonly config?: ContinueWatchdogConfig;
	readonly clock?: RuntimeClock;
	readonly createExchangeId?: () => string;
	readonly loadConfig?: (options: LoadRuntimeConfigOptions) => Promise<LoadedConfig>;
	readonly agentDir?: string;
}

/** Register one attachment's public Pi lifecycle wiring. */
export function createContinueWatchdogExtension(
	options: ContinueWatchdogExtensionOptions = {},
): (pi: ExtensionAPI) => void {
	const hub = options.hub ?? getProcessObservableAgentHub();
	const useProductionDomain =
		options.processDomain !== undefined || (options.hub === undefined && options.controller === undefined);
	const processDomain = useProductionDomain ? (options.processDomain ?? getProcessDomainCoordinator()) : undefined;
	const fatalExit = useProductionDomain ? (options.fatalExit ?? createFatalExitAdapter()) : options.fatalExit;
	const attachmentInstance = createHubAttachmentInstance();
	const holder: RuntimeControllerHolder = {
		controller: options.controller ?? null,
	};

	return (pi: ExtensionAPI): void => {
		let commandRuntime: MainCommandRuntime | null = null;
		const runtime = createDecisionRuntime({
			pi,
			hub,
			processDomain,
			fatalExit,
			attachmentInstance,
			controllerHolder: holder,
			injectedController: options.controller !== undefined,
			initialConfig: options.config,
			clock: options.clock,
			createExchangeId: options.createExchangeId,
			loadConfig: options.loadConfig,
			agentDir: options.agentDir,
			onConfigReady: (config) => {
				if (config.unlockShortcut === false) return;
				const key = config.unlockShortcut;
				pi.registerShortcut(key as KeyId, {
					description: "Unlock continue watchdog (pi-continue-watchdog)",
					handler: (shortcutCtx) => {
						if (commandRuntime === null) return;
						return handleUnlock(pi, commandRuntime, "", shortcutCtx as ExtensionCommandContext);
					},
				});
			},
		});

		commandRuntime = {
			get controller() {
				return holder.controller;
			},
			setSessionEnabled: (enabled: boolean) => runtime.setSessionEnabled(enabled),
			isCurrentMain: runtime.isCurrentMain,
			getTriggerStatus: runtime.getTriggerStatus,
			getMainClaim: runtime.getMainClaim,
			isCurrentMainClaim: runtime.isCurrentMainClaim,
			restartLockCycle: (ctx, restartOptions) => runtime.restartLockCycle(ctx, restartOptions),
			clearOperationalPendingWork: () => runtime.clearOperationalPendingWork(),
			handleManualUnlock: (ctx, claim) => runtime.handleManualUnlock(ctx, claim),
			applyEffect: runtime.applyEffect,
			reconcileIdle: runtime.reconcileIdle,
		};
		createMainCommands(pi, commandRuntime);
		registerDecisionContextFolding(pi);
		// Native summary isolation: the same exact-exchange projection used for
		// ordinary requests also rewrites the host's own compaction and
		// branch-summary preparations in place, so internal decision traffic
		// stays out of native model input while accepted continuations survive
		// at their original fold positions.
		pi.on("session_before_compact", (event) => {
			if (event.signal.aborted) return;
			projectCompactionPreparation(event.preparation, event.branchEntries);
		});
		pi.on("session_before_tree", (event, ctx) => {
			if (event.signal.aborted) return;
			if (!event.preparation.userWantsSummary) return;
			const oldBranch = ctx.sessionManager.getBranch(event.preparation.oldLeafId ?? undefined);
			projectBranchPreparation(event.preparation, oldBranch);
		});
		// Correlate a pending watchdog dispatch before real-user auto-lock can
		// restart the cycle and discard the identity needed to downgrade a foreign run.
		pi.on("message_start", (event, ctx) => runtime.handleMessageStart(event, ctx));

		registerMainUserAutoLock(pi, {
			isCurrentMain: runtime.isCurrentMain,
			onMainUserMessageStart(): void {
				// Off by default: only a session that opted in keeps a lock cycle.
				if (!runtime.isSessionEnabled()) return;
				runtime.restartLockCycle(undefined, { notifyLocked: false });
			},
		});

		const abortUnlock = registerMainAbortUnlock(pi, {
			isCurrentMain: runtime.isCurrentMain,
			getMainClaim: runtime.getMainClaim,
			isCurrentMainClaim: runtime.isCurrentMainClaim,
			get controller() {
				return holder.controller;
			},
			clearOperationalPendingWork: () => runtime.clearOperationalPendingWork(),
			retainErrorUnlock: runtime.retainErrorUnlock,
			consumeDecisionAbortSuppression: () => runtime.consumeDecisionAbortSuppression(),
			applyEffect: runtime.applyEffect,
		});

		// Background shells count as activity: never ask for a decision while a
		// task started by bg_run is still running.
		const unsubscribeBackgroundActivity = pi.events.on(BACKGROUND_ACTIVITY_EVENT, (payload) => {
			const running = (payload as { readonly running?: unknown } | undefined)?.running;
			if (typeof running === "number" && Number.isSafeInteger(running)) {
				runtime.setBackgroundTasksRunning(running);
			}
		});

		// Abort handlers register first; Pi awaits event handlers in registration order.
		runtime.registerLifecycle();

		pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
			unsubscribeBackgroundActivity();
			runtime.setBackgroundTasksRunning(0);
			abortUnlock.clear();
			await runtime.shutdown(ctx);
			fatalExit?.completeShutdown();
		});
	};
}

export default function registerContinueWatchdogExtension(pi: ExtensionAPI): void {
	createContinueWatchdogExtension()(pi);
}
