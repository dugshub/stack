#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Builtins, Cli, Command, type CommandClass } from 'clipanion';
import { showDashboard } from './lib/dashboard.js';
import * as git from './lib/git.js';
import { renderHelp } from './lib/help.js';
import { theme } from './lib/theme.js';
import * as ui from './lib/ui.js';
import { checkForUpdate, currentVersion } from './lib/version.js';

type AnyCommandClass = CommandClass;

const cli = new Cli({
  binaryLabel: 'st',
  binaryName: 'st',
  binaryVersion: currentVersion(),
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

// Auto-discover and register all commands from src/commands/
const commandsDir = join(import.meta.dir, 'commands');
const commandFiles = readdirSync(commandsDir).filter(f =>
  (f.endsWith('.ts') || f.endsWith('.js')) && !f.includes('.test.'),
);
for (const file of commandFiles) {
  const mod = await import(join(commandsDir, file));
  for (const exp of Object.values(mod)) {
    if (typeof exp === 'function' && exp.prototype instanceof Command) {
      cli.register(exp as typeof Command);
    }
  }
}

// Commands that don't require a git repo
const noRepoRequired = ['--help', '-h', '--version', '-v', '-i', '--interactive', 'help', 'version', 'update', '--ai', 'daemon', 'completions', '_complete', 'login', 'logout'];
const rawArgs = process.argv.slice(2);

// `st 3` → `st nav 3`
const args = rawArgs.length === 1 && /^\d+$/.test(rawArgs[0] ?? '')
  ? ['nav', rawArgs[0]!]
  : rawArgs;

// `st s ...` → `st stack ...`, `st b ...` → `st branch ...`
const groupShorthands: Record<string, string> = { s: 'stack', b: 'branch' };
if (args[0] && args[0] in groupShorthands) {
  args[0] = groupShorthands[args[0]]!;
}

// Bare `st stack` and `st branch` show help (no repo needed)
const isBareGroupHelp = args.length === 1 && (args[0] === 'stack' || args[0] === 'branch');
const needsRepo = args.length > 0 && !isBareGroupHelp && !args.some((a) => noRepoRequired.includes(a));

if (needsRepo && !git.tryRun('rev-parse', '--show-toplevel').ok) {
  ui.error('Not in a git repository.');
  process.exit(2);
}

// Show help text
function showHelp(): never {
  const v = currentVersion();
  process.stderr.write(`\n  ${theme.label(`st`)} ${theme.muted(`v${v}`)}\n`);
  process.stderr.write(`  ${theme.muted('Stacked PRs for GitHub')}\n\n`);

  const cmds = [
    ['<name>',               'Switch to a stack'],
    ['<number>',             'Jump to branch N'],
    ['create <name>',        'Start a new stack'],
    ['status',               'Show stack status'],
    ['submit',               'Push branches, create PRs'],
    ['up / down',            'Navigate branches'],
    ['modify',               'Amend and restack'],
    ['sync',                 'Clean up after merges'],
    ['',                     ''],
    ['stack | s ...',         'Stack operations (create, delete, submit, merge, ...)'],
    ['branch | b ...',        'Branch operations (up, down, fold, move, insert, ...)'],
    ['',                     ''],
    ['continue / abort',     'Conflict resolution'],
    ['undo',                 'Undo last command'],
    ['config',               'View/update settings'],
  ];

  for (const [cmd, desc] of cmds) {
    if (!cmd) {
      process.stderr.write('\n');
      continue;
    }
    process.stderr.write(`    ${theme.command(`st ${cmd}`.padEnd(32))} ${theme.muted(desc ?? '')}\n`);
  }

  process.stderr.write(`\n  ${theme.muted('Run st stack -h or st branch -h for full command lists')}\n`);
  process.stderr.write(`  ${theme.muted('Run --ai or <command> --ai for LLM-friendly docs')}\n\n`);
  process.exit(0);
}

// Show concise first-run guide for new users (no stacks exist yet)
function showFirstRun(): never {
  const v = currentVersion();
  process.stderr.write(`\n  ${theme.label('st')} ${theme.muted(`v${v}`)}\n`);
  process.stderr.write(`  ${theme.muted('Stacked PRs for GitHub')}\n\n`);
  process.stderr.write(`  ${theme.command('Get started:')}\n`);
  process.stderr.write(`    ${theme.command('st create my-feature')}    ${theme.muted('Create your first stack')}\n`);
  process.stderr.write(`    ${theme.command('st --help')}               ${theme.muted('See all commands')}\n\n`);
  process.stderr.write(`  ${theme.command('Already have branches?')}\n`);
  process.stderr.write(`    ${theme.command('st create name --from branch1 branch2')}    ${theme.muted('Adopt existing branches')}\n\n`);
  process.exit(0);
}

interface HelpLookupResult {
	definition: ReturnType<typeof cli.definitions>[number];
	aliases: string[];
}

/**
 * Find the Definition for a command given its CLI args (without -h/--help).
 * Handles aliases by trying all registered command paths.
 * Returns the definition and any alias usage strings.
 */
function findHelpDefinition(cliInstance: typeof cli, argsWithoutHelp: string[]): HelpLookupResult | null {
	const defs = cliInstance.definitions();

	// Helper: given a command class, return its Definition and alias usage strings
	function resolveFromClass(commandClass: AnyCommandClass): HelpLookupResult | null {
		const def = cliInstance.definition(commandClass);
		if (!def) return null;

		// Build aliases from the command's static paths
		const allPaths = commandClass.paths ?? [];
		const aliases: string[] = [];
		for (const pathSegments of allPaths) {
			const usagePath = `st ${pathSegments.join(' ')}`;
			// Skip the canonical path (shown in Usage already)
			if (usagePath === def.path) continue;
			// Build an alias usage string that mirrors the canonical usage
			// Replace the path portion in def.usage with this alias
			const canonicalPath = def.path.replace(/^st /, '');
			const aliasPath = pathSegments.join(' ');
			const aliasUsage = def.usage.replace(canonicalPath, aliasPath);
			aliases.push(aliasUsage);
		}
		return { definition: def, aliases };
	}

	// Direct match against definition path (e.g., "st stack check")
	const pathKey = `st ${argsWithoutHelp.join(' ')}`;

	// Access internal registrations map (typed loosely to avoid clipanion's abstract class issues)
	type RegistrationMap = Map<AnyCommandClass, unknown>;
	const registrations = (cliInstance as unknown as { registrations: RegistrationMap }).registrations;

	// Try to find the matching command class from registrations
	for (const [commandClass] of registrations) {
		const allPaths = commandClass.paths ?? [];
		for (const pathSegments of allPaths) {
			if (`st ${pathSegments.join(' ')}` === pathKey) {
				return resolveFromClass(commandClass);
			}
		}
	}

	// Try to process the command to resolve aliases
	try {
		const command = cliInstance.process({ input: argsWithoutHelp });
		const commandClass = command.constructor as AnyCommandClass;
		return resolveFromClass(commandClass);
	} catch {
		// Commands with required positional args will throw when called bare.
		// Try matching "st stack <arg>" and "st branch <arg>" for aliases
		const firstArg = argsWithoutHelp[0];
		const secondArg = argsWithoutHelp[1];

		for (const group of ['stack', 'branch']) {
			const groupedKey = secondArg
				? `st ${group} ${firstArg} ${secondArg}`
				: `st ${group} ${firstArg}`;
			for (const [commandClass] of registrations) {
				const allPaths = commandClass.paths ?? [];
				for (const pathSegments of allPaths) {
					if (`st ${pathSegments.join(' ')}` === groupedKey) {
						return resolveFromClass(commandClass);
					}
				}
			}
		}
	}

	return null;
}

// `st --ai [command]` — plain-text docs for LLMs
if (args.includes('--ai')) {
  const { printAiDocs } = await import('./lib/ai-docs.js');
  const nonAiArgs = args.filter((a) => a !== '--ai');
  // Handle grouped commands: `st stack submit --ai` → cmdArg = 'submit'
  // Handle flat commands: `st submit --ai` → cmdArg = 'submit'
  const groups = ['stack', 'branch'];
  const cmdArg = groups.includes(nonAiArgs[0] ?? '')
    ? nonAiArgs[1] ?? nonAiArgs[0]
    : nonAiArgs[0];
  printAiDocs(cmdArg);
  process.exit(0);
}

// `stack --help` / `stack -h` — always show our custom help
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  showHelp();
}

// `st -i` — interactive graph
if (args.length === 1 && (args[0] === '-i' || args[0] === '--interactive')) {
  if (git.tryRun('rev-parse', '--show-toplevel').ok) {
    const { showInteractiveGraph } = await import('./lib/interactive-graph.js');
    const result = await showInteractiveGraph();
    process.exit(result);
  }
  ui.error('Not in a git repository.');
  process.exit(2);
}

// Bare `stack` with no args — show dashboard if stacks exist, otherwise first-run guide
if (args.length === 0) {
  if (git.tryRun('rev-parse', '--show-toplevel').ok) {
    const dashResult = await showDashboard();
    if (dashResult !== null) {
      const updateMsg = checkForUpdate();
      if (updateMsg) {
        process.stderr.write(`\n${theme.warning(updateMsg)}\n`);
      }
      process.exit(dashResult);
    }
  }
  // No stacks exist — show first-run guide
  showFirstRun();
}

// Auto-start daemon unless running a command that doesn't need it
const noDaemonCommands = ['daemon', 'update', 'completions', '_complete', 'login', 'logout', '--help', '-h', '--version', '-v', '--ai'];
const skipDaemon = args.length === 0 || args.some((a) => noDaemonCommands.includes(a));
if (!skipDaemon) {
  try {
    const { ensureDaemon } = await import('./server/lifecycle.js');
    await ensureDaemon();
  } catch { /* daemon start failed — non-fatal, commands still work */ }
}

// Intercept `-h` / `--help` on any command to render custom help
if (args.some((a) => a === '-h' || a === '--help')) {
	const argsWithoutHelp = args.filter((a) => a !== '-h' && a !== '--help');
	if (argsWithoutHelp.length > 0) {
		const result = findHelpDefinition(cli, argsWithoutHelp);
		if (result) {
			renderHelp(result.definition, { aliases: result.aliases });
			process.exit(0);
		}
	}
}

// Check for updates after command runs (non-blocking)
const exitCode = await cli.run(args);
process.stderr.write('\n');
if (args[0] !== 'update') {
  const updateMsg = checkForUpdate();
  if (updateMsg) {
    process.stderr.write(`\n${theme.warning(updateMsg)}\n`);
  }
}
process.exit(exitCode);
