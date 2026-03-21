import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'clipanion';
import * as git from '../lib/git.js';

/**
 * Hidden command used by shell completion scripts.
 * Outputs newline-separated completion words for the current context.
 * Reads the state file directly (no git ops) for speed.
 */
export class CompleteCommand extends Command {
	static override paths = [['_complete']];
	static override usage = Command.Usage({ description: 'Internal: generate completions' });

	type = Option.String({ required: true, name: 'type' });

	async execute(): Promise<number> {
		const state = this.loadStateQuiet();
		if (!state) return 0;

		switch (this.type) {
			case 'stacks':
				for (const name of Object.keys(state.stacks)) {
					process.stdout.write(`${name}\n`);
				}
				break;
			case 'branches': {
				// Output branch names from current stack
				const current = this.currentStackName(state);
				if (current && state.stacks[current]) {
					for (const b of state.stacks[current].branches) {
						process.stdout.write(`${b.name}\n`);
					}
				}
				break;
			}
			case 'all-branches': {
				// Output all branch names across all stacks
				for (const stack of Object.values(state.stacks)) {
					for (const b of stack.branches) {
						process.stdout.write(`${b.name}\n`);
					}
				}
				break;
			}
			default:
				break;
		}
		return 0;
	}

	private loadStateQuiet(): any {
		try {
			const repoName = git.repoBasename();
			const filePath = join(homedir(), '.claude', 'stacks', `${repoName}.json`);
			return JSON.parse(readFileSync(filePath, 'utf-8'));
		} catch {
			return null;
		}
	}

	private currentStackName(state: any): string | null {
		if (state.currentStack) return state.currentStack;
		// Detect from current branch
		try {
			const branch = git.run('rev-parse', '--abbrev-ref', 'HEAD');
			for (const [name, stack] of Object.entries(state.stacks) as any[]) {
				if (stack.branches.some((b: any) => b.name === branch)) return name;
			}
		} catch { /* ignore */ }
		return null;
	}
}
