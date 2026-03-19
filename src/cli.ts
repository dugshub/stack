#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Builtins, Cli, Command } from 'clipanion';
import { showDashboard } from './lib/dashboard.js';
import * as git from './lib/git.js';
import { theme } from './lib/theme.js';
import * as ui from './lib/ui.js';
import { checkForUpdate, currentVersion } from './lib/version.js';

const cli = new Cli({
  binaryLabel: 'stack',
  binaryName: 'stack',
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
const noRepoRequired = ['--help', '-h', '--version', '-v', 'help', 'version', 'update', '--ai', 'daemon', 'completions'];
const rawArgs = process.argv.slice(2);

// `stack 3` → `stack nav 3`
const args = rawArgs.length === 1 && /^\d+$/.test(rawArgs[0] ?? '')
  ? ['nav', rawArgs[0]!]
  : rawArgs;

const needsRepo = args.length > 0 && !args.some((a) => noRepoRequired.includes(a));

if (needsRepo && !git.tryRun('rev-parse', '--show-toplevel').ok) {
  ui.error('Not in a git repository.');
  process.exit(2);
}

// Show help text
function showHelp(): never {
  const v = currentVersion();
  process.stderr.write(`\n  ${theme.label(`stack`)} ${theme.muted(`v${v}`)}\n`);
  process.stderr.write(`  ${theme.muted('Stacked PRs for GitHub')}\n\n`);

  const cmds = [
    ['<name>',                    'Switch to a stack'],
    ['<number>',                  'Jump to branch N in current stack'],
    ['create [name]',           'Start a new stack'],
    ['delete [name]',           'Remove a stack from tracking'],
    ['status',                  'Show stack and PR status'],
    ['',                        ''],
    ['track',                   'Add current branch to a stack'],
    ['remove [branch]',         'Remove a branch from the stack'],
    ['pop',                     'Pop branch from stack, keep changes'],
    ['fold',                    'Fold branch into parent'],
    ['rename <new-name>',       'Rename current branch'],
    ['up',                      'Move up (toward trunk)'],
    ['down',                    'Move down (away from trunk)'],
    ['top',                     'Jump to top of stack'],
    ['bottom',                  'Jump to bottom of stack'],
    ['continue',                'Continue after resolving conflicts'],
    ['abort',                   'Abort an in-progress restack'],
    ['nav',                     'Interactive branch picker'],
    ['move <up|down|N>',        'Move a branch within the stack'],
    ['insert --after N',        'Insert a new branch at position'],
    ['reorder [positions]',     'Reorder branches in the stack'],
    ['',                        ''],
    ['submit',                  'Push branches, create/update PRs'],
    ['modify',                  'Amend and restack'],
    ['absorb',                  'Route fixes to correct stack branches'],
    ['split [specs...]',        'Split uncommitted changes into a stack'],
    ['restack',                 'Rebase downstream after mid-stack edits'],
    ['check <cmd...>',           'Run a command on every branch'],
    ['sync',                    'Clean up after PRs merge'],
    ['undo',                    'Undo last mutating command'],
    ['merge --all',             'Merge entire stack bottom-up'],
    ['graph',                   'Show dependency graph across stacks'],
    ['daemon <action>',         'Manage background daemon'],
    ['',                        ''],
    ['completions [shell]',     'Shell tab completions'],
    ['init',                    'Install Claude Code skills'],
    ['update',                  'Self-update to latest version'],
  ];

  for (const [cmd, desc] of cmds) {
    if (!cmd) {
      process.stderr.write('\n');
      continue;
    }
    process.stderr.write(`  ${theme.command(`stack ${cmd}`.padEnd(34))} ${theme.muted(desc ?? '')}\n`);
  }

  process.stderr.write(`\n  ${theme.muted('Run any command with -h for details')}\n`);
  process.stderr.write(`  ${theme.muted('Run --ai or <command> --ai for LLM-friendly docs')}\n\n`);
  process.exit(0);
}

// Show concise first-run guide for new users (no stacks exist yet)
function showFirstRun(): never {
  const v = currentVersion();
  process.stderr.write(`\n  ${theme.label('stack')} ${theme.muted(`v${v}`)}\n`);
  process.stderr.write(`  ${theme.muted('Stacked PRs for GitHub')}\n\n`);
  process.stderr.write(`  ${theme.command('Get started:')}\n`);
  process.stderr.write(`    ${theme.command('stack create my-feature')}    ${theme.muted('Create your first stack')}\n`);
  process.stderr.write(`    ${theme.command('stack --help')}               ${theme.muted('See all commands')}\n\n`);
  process.stderr.write(`  ${theme.command('Already have branches?')}\n`);
  process.stderr.write(`    ${theme.command('stack create name --from branch1 branch2')}    ${theme.muted('Adopt existing branches')}\n\n`);
  process.exit(0);
}

// `stack --ai [command]` — plain-text docs for LLMs
if (args.includes('--ai')) {
  const { printAiDocs } = await import('./lib/ai-docs.js');
  const cmdArg = args.filter((a) => a !== '--ai')[0];
  printAiDocs(cmdArg);
  process.exit(0);
}

// `stack --help` / `stack -h` — always show our custom help
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  showHelp();
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
const noDaemonCommands = ['daemon', 'update', 'completions', '--help', '-h', '--version', '-v', '--ai'];
const skipDaemon = args.length === 0 || args.some((a) => noDaemonCommands.includes(a));
if (!skipDaemon) {
  try {
    const { ensureDaemon } = await import('./server/lifecycle.js');
    await ensureDaemon();

    // Fire-and-forget: register current repo with daemon
    if (git.tryRun('rev-parse', '--show-toplevel').ok) {
      try {
        const { loadState } = await import('./lib/state.js');
        const { loadDaemonToken } = await import('./lib/daemon-client.js');
        const { getDaemonPort } = await import('./server/lifecycle.js');
        const state = loadState();
        let repoName = state.repo;
        if (!repoName) {
          const { repoFullName } = await import('./lib/gh.js');
          repoName = repoFullName();
        }
        if (repoName) {
          const token = loadDaemonToken();
          const port = getDaemonPort();
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (token) headers.Authorization = `Bearer ${token}`;
          fetch(`http://localhost:${port}/api/repos`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ repo: repoName }),
            signal: AbortSignal.timeout(1000),
          }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }
  } catch { /* daemon start failed — non-fatal, commands still work */ }
}

// Check for updates after command runs (non-blocking)
const exitCode = await cli.run(args);
if (args[0] !== 'update') {
  const updateMsg = checkForUpdate();
  if (updateMsg) {
    process.stderr.write(`\n${theme.warning(updateMsg)}\n`);
  }
}
process.exit(exitCode);
