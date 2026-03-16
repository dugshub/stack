import { theme } from './theme.js';

export interface CheckStatus {
	name: string;
	status: 'queued' | 'in_progress' | 'completed';
	conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | null;
	startedAt?: string;
}

export interface StepDisplay {
	prNumber: number;
	branchShort: string;
	state:
		| 'pending'
		| 'checks-running'
		| 'auto-merge-enabled'
		| 'merging'
		| 'merged'
		| 'rebasing'
		| 'failed';
	checks?: CheckStatus[];
	elapsed?: number;
	error?: string;
}

export interface MergeDisplay {
	stackName: string;
	steps: StepDisplay[];
	activeMessage?: string;
	totalElapsed: number;
}

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return `${min}m ${sec}s`;
	const hr = Math.floor(min / 60);
	const remainMin = min % 60;
	return `${hr}h ${remainMin}m`;
}

function stepIcon(state: StepDisplay['state']): string {
	switch (state) {
		case 'merged':
			return theme.success('\u2713');
		case 'failed':
			return theme.error('\u2717');
		case 'checks-running':
		case 'auto-merge-enabled':
		case 'merging':
		case 'rebasing':
			return theme.warning('\u23F3');
		case 'pending':
			return theme.muted('\u25CB');
	}
}

function checkIcon(check: CheckStatus): string {
	if (check.status === 'completed') {
		if (check.conclusion === 'success' || check.conclusion === 'neutral' || check.conclusion === 'skipped') {
			return theme.success('\u2713');
		}
		return theme.error('\u2717');
	}
	if (check.status === 'in_progress') {
		return theme.warning('\u25F7');
	}
	return theme.muted('\u25CB');
}

function stepSuffix(step: StepDisplay): string {
	switch (step.state) {
		case 'merged':
			return `merged${step.elapsed != null ? ` (${formatElapsed(step.elapsed)})` : ''}`;
		case 'failed':
			return `failed${step.error ? `: ${step.error}` : ''}`;
		case 'checks-running':
			return 'checks running...';
		case 'auto-merge-enabled':
			return 'auto-merge enabled...';
		case 'merging':
			return 'merging...';
		case 'rebasing':
			return 'rebasing...';
		case 'pending':
			return 'pending';
	}
}

/** Render the display model to a string (no ANSI cursor movement -- just the frame). */
export function renderMergeDisplay(display: MergeDisplay): string {
	const lines: string[] = [];

	lines.push(`  ${theme.label(`Merging stack: ${display.stackName}`)}`);
	lines.push(`  ${theme.muted('\u2500'.repeat(34))}`);
	lines.push('');

	for (const step of display.steps) {
		const icon = stepIcon(step.state);
		const pr = theme.pr(`#${step.prNumber}`);
		const branch = theme.branch(step.branchShort.padEnd(22));
		const suffix = theme.muted(stepSuffix(step));
		lines.push(`  ${pr}  ${branch} ${icon} ${suffix}`);

		// Show checks for active steps
		if (step.checks && step.checks.length > 0 && step.state !== 'merged' && step.state !== 'pending') {
			for (let i = 0; i < step.checks.length; i++) {
				const check = step.checks[i];
				if (!check) continue;
				const connector = i === step.checks.length - 1 ? '\u2514\u2500' : '\u251C\u2500';
				const ci = checkIcon(check);
				let checkSuffix = '';
				if (check.status === 'completed') {
					checkSuffix = check.conclusion === 'success' ? 'passed' : (check.conclusion ?? 'unknown');
				} else if (check.status === 'in_progress' && check.startedAt) {
					const elapsed = Date.now() - new Date(check.startedAt).getTime();
					checkSuffix = `running (${formatElapsed(elapsed)})`;
				} else if (check.status === 'in_progress') {
					checkSuffix = 'running';
				} else {
					checkSuffix = 'queued';
				}
				lines.push(`       ${connector} ${check.name.padEnd(20)} ${ci} ${theme.muted(checkSuffix)}`);
			}
		}
	}

	if (display.activeMessage) {
		lines.push('');
		lines.push(`  ${theme.warning('\u21BB')} ${display.activeMessage}`);
	}

	lines.push('');
	lines.push(`  ${theme.muted(`Elapsed: ${formatElapsed(display.totalElapsed)}`)}`);

	return lines.join('\n');
}

/** Return the number of lines in the last render (for cursor rewind). */
export function lineCount(rendered: string): number {
	return rendered.split('\n').length;
}
