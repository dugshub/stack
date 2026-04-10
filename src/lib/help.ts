import type { Definition } from 'clipanion';
import { theme } from './theme.js';
import { currentVersion } from './version.js';

export interface HelpOptions {
	/** Alternative command paths (aliases) for this command */
	aliases?: string[];
}

/**
 * Render a beautiful, colored help page for a command definition.
 * Outputs to stderr (matching CLI convention).
 */
export function renderHelp(definition: Definition, options?: HelpOptions): void {
	const v = currentVersion();

	// Header: command path + version
	const commandPath = definition.path || 'st';
	process.stderr.write('\n');
	process.stderr.write(`  ${theme.label(commandPath)} ${theme.muted(`v${v}`)}\n`);

	// Description
	if (definition.description) {
		const desc = definition.description.replace(/\n$/, '');
		process.stderr.write(`  ${desc}\n`);
	}

	// Usage
	if (definition.usage) {
		process.stderr.write('\n');
		process.stderr.write(`  ${theme.label('Usage')}\n`);
		process.stderr.write(`    ${theme.accent('$')} ${theme.accent(definition.usage)}\n`);

		// Show aliases
		if (options?.aliases && options.aliases.length > 0) {
			for (const alias of options.aliases) {
				process.stderr.write(`    ${theme.accent('$')} ${theme.muted(alias)}  ${theme.muted('(alias)')}\n`);
			}
		}
	}

	// Options
	if (definition.options && definition.options.length > 0) {
		process.stderr.write('\n');
		process.stderr.write(`  ${theme.label('Options')}\n`);

		// Calculate max width for alignment
		const maxNameWidth = Math.max(
			...definition.options.map((opt) => formatOptionName(opt).length),
		);

		for (const opt of definition.options) {
			const name = formatOptionName(opt);
			const desc = opt.description ?? '';
			const required = opt.required ? theme.warning(' (required)') : '';
			process.stderr.write(
				`    ${theme.accent(name.padEnd(maxNameWidth))}  ${theme.muted(desc)}${required}\n`,
			);
		}
	}

	// Details
	if (definition.details) {
		process.stderr.write('\n');
		process.stderr.write(`  ${theme.label('Details')}\n`);
		const details = definition.details.replace(/\n$/, '');
		for (const line of details.split('\n')) {
			process.stderr.write(`    ${line}\n`);
		}
	}

	// Examples
	if (definition.examples && definition.examples.length > 0) {
		process.stderr.write('\n');
		process.stderr.write(`  ${theme.label('Examples')}\n`);

		for (const [description, command] of definition.examples) {
			const desc = description.replace(/\n$/, '');
			process.stderr.write(`    ${theme.muted(desc)}\n`);
			process.stderr.write(`    ${theme.accent('$')} ${theme.command(command)}\n`);
			process.stderr.write('\n');
		}
	} else {
		process.stderr.write('\n');
	}
}

/**
 * Format an option's name set into a readable string.
 * e.g. "--stack,-s <value>" or "--dry-run" or "-f,--follow"
 */
function formatOptionName(opt: Definition['options'][number]): string {
	const names = opt.nameSet.join(',');
	// If the definition contains a value placeholder (e.g. "#0"), show <value>
	if (opt.definition.includes('#') || opt.definition.includes(' ')) {
		return `${names} <value>`;
	}
	return names;
}
