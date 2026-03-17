import type { EngineAction, MergeJob, WebhookEvent } from './types.js';

/** PR-related events that the engine handles (excludes push events) */
type PREvent = Exclude<WebhookEvent, { type: 'push' }>;

export function processEvent(
	job: MergeJob,
	event: PREvent,
): { job: MergeJob; actions: EngineAction[] } {
	const updated = structuredClone(job);
	const actions: EngineAction[] = [];

	const currentStep = updated.steps[updated.currentStep];
	if (!currentStep) {
		return { job: updated, actions };
	}

	// Only process events for the current step's PR
	if (event.prNumber !== currentStep.prNumber) {
		return { job: updated, actions };
	}

	if (event.type === 'pr_merged') {
		currentStep.status = 'merged';
		currentStep.mergedAt = new Date().toISOString();
		updated.updated = new Date().toISOString();

		const nextIndex = updated.currentStep + 1;
		const nextStep = updated.steps[nextIndex];

		if (nextStep) {
			// There is a next step: rebase, retarget, enable auto-merge
			if (!currentStep.branchTip) {
				currentStep.status = 'failed';
				currentStep.error =
					'Missing branch tip — cannot determine rebase exclusion point';
				updated.status = 'failed';
				updated.updated = new Date().toISOString();
				actions.push({
					type: 'notify',
					message: `#${currentStep.prNumber} merged but rebase failed: missing branch tip`,
					level: 'error',
				});
				return { job: updated, actions };
			}

			currentStep.status = 'rebasing-next';

			actions.push({
				type: 'rebase-and-push',
				branch: nextStep.branch,
				onto: updated.trunk,
				oldBase: currentStep.branchTip,
			});

			actions.push({
				type: 'retarget-pr',
				prNumber: nextStep.prNumber,
				newBase: updated.trunk,
			});

			actions.push({
				type: 'enable-auto-merge',
				prNumber: nextStep.prNumber,
				strategy: updated.strategy,
			});

			actions.push({
				type: 'notify',
				message: `#${currentStep.prNumber} merged. Rebasing #${nextStep.prNumber}...`,
				level: 'info',
			});

			// Leave step in 'rebasing-next' — the server handler will
			// transition to 'done' after actions execute successfully.
			// Store nextIndex so the handler knows where to advance.
			updated.pendingNextStep = nextIndex;
		} else {
			// Last step: clean up
			currentStep.status = 'done';
			updated.status = 'completed';

			actions.push({
				type: 'delete-branches',
				branches: updated.steps.map((s) => ({
					name: s.branch,
					remote: true,
				})),
			});

			actions.push({
				type: 'notify',
				message: `Stack "${updated.stackName}" fully merged (${updated.steps.length} PRs)`,
				level: 'success',
			});
		}

		return { job: updated, actions };
	}

	if (event.type === 'auto_merge_disabled') {
		currentStep.status = 'failed';
		currentStep.error = event.reason;
		updated.status = 'failed';
		updated.updated = new Date().toISOString();

		actions.push({
			type: 'notify',
			message: `Auto-merge disabled on #${currentStep.prNumber}: ${event.reason}`,
			level: 'error',
		});

		return { job: updated, actions };
	}

	if (event.type === 'pr_closed') {
		currentStep.status = 'failed';
		currentStep.error = 'PR closed without merging';
		updated.status = 'failed';
		updated.updated = new Date().toISOString();

		actions.push({
			type: 'notify',
			message: `#${currentStep.prNumber} closed without merging. Job failed.`,
			level: 'error',
		});

		return { job: updated, actions };
	}

	return { job: updated, actions };
}

// Engine processes webhook events through a state machine
