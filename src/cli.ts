#!/usr/bin/env bun
import { Builtins, Cli } from 'clipanion';
import { AbortCommand } from './commands/abort.js';
import { AbsorbCommand } from './commands/absorb.js';
import { BottomCommand } from './commands/bottom.js';
import { CheckCommand } from './commands/check.js';
import { ContinueCommand } from './commands/continue.js';
import { CreateCommand } from './commands/create.js';
import { DaemonCommand } from './commands/daemon.js';
import { DefaultCommand } from './commands/default.js';
import { DownCommand } from './commands/down.js';
import { FoldCommand } from './commands/fold.js';
import { GraphCommand } from './commands/graph.js';
import { MergeCommand } from './commands/merge.js';
import { ModifyCommand } from './commands/modify.js';
import { DeleteCommand } from './commands/delete.js';
import { InitCommand } from './commands/init.js';
import { InsertCommand } from './commands/insert.js';
import { MoveCommand } from './commands/move.js';
import { NavCommand } from './commands/nav.js';
import { PopCommand } from './commands/pop.js';
import { TrackCommand } from './commands/track.js';
import { RemoveCommand } from './commands/remove.js';
import { RenameCommand } from './commands/rename.js';
import { ReorderCommand } from './commands/reorder.js';
import { RestackCommand } from './commands/restack.js';
import { StatusCommand } from './commands/status.js';
import { SubmitCommand } from './commands/submit.js';
import { SplitCommand } from './commands/split.js';
import { SyncCommand } from './commands/sync.js';
import { TopCommand } from './commands/top.js';
import { UndoCommand } from './commands/undo.js';
import { UpCommand } from './commands/up.js';
import { UpdateCommand } from './commands/update.js';
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
cli.register(StatusCommand);
cli.register(NavCommand);
cli.register(UpCommand);
cli.register(DownCommand);
cli.register(TopCommand);
cli.register(BottomCommand);
cli.register(MoveCommand);
cli.register(InsertCommand);
cli.register(ReorderCommand);
cli.register(CreateCommand);
cli.register(DeleteCommand);
cli.register(TrackCommand);
cli.register(PopCommand);
cli.register(RemoveCommand);
cli.register(SubmitCommand);
cli.register(ModifyCommand);
cli.register(AbsorbCommand);
cli.register(CheckCommand);
cli.register(ContinueCommand);
cli.register(AbortCommand);
cli.register(RestackCommand);
cli.register(SplitCommand);
cli.register(SyncCommand);
cli.register(UndoCommand);
cli.register(MergeCommand);
cli.register(FoldCommand);
cli.register(RenameCommand);
cli.register(DaemonCommand);
cli.register(GraphCommand);
cli.register(InitCommand);
cli.register(UpdateCommand);
cli.register(DefaultCommand);

// Commands that don't require a git repo
const noRepoRequired = ['--help', '-h', '--version', '-v', 'help', 'version', 'update', '--ai', 'daemon'];
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

// Bare `stack` with no args — show dashboard if stacks exist, otherwise help
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
  showHelp();
}

// Auto-start daemon unless running a command that doesn't need it
const noDaemonCommands = ['daemon', 'update', '--help', '-h', '--version', '-v', '--ai'];
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
