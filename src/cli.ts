#!/usr/bin/env bun
import { Builtins, Cli } from 'clipanion';
import { AbsorbCommand } from './commands/absorb.js';
import { CreateCommand } from './commands/create.js';
import { MergeCommand } from './commands/merge.js';
import { DeleteCommand } from './commands/delete.js';
import { InitCommand } from './commands/init.js';
import { NavCommand } from './commands/nav.js';
import { PushCommand } from './commands/push.js';
import { RemoveCommand } from './commands/remove.js';
import { SplitCommand } from './commands/split.js';
import { RestackCommand } from './commands/restack.js';
import { StatusCommand } from './commands/status.js';
import { SubmitCommand } from './commands/submit.js';
import { SyncCommand } from './commands/sync.js';
import { UpdateCommand } from './commands/update.js';
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
cli.register(CreateCommand);
cli.register(DeleteCommand);
cli.register(PushCommand);
cli.register(RemoveCommand);
cli.register(SubmitCommand);
cli.register(AbsorbCommand);
cli.register(RestackCommand);
cli.register(SyncCommand);
cli.register(MergeCommand);
cli.register(SplitCommand);
cli.register(InitCommand);
cli.register(UpdateCommand);

// Commands that don't require a git repo
const noRepoRequired = ['--help', '-h', '--version', '-v', 'help', 'version', 'update'];
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

// Bare `stack` with no args — show styled usage instead of clipanion default
if (args.length === 0) {
  const v = currentVersion();
  process.stderr.write(`\n  ${theme.label(`stack`)} ${theme.muted(`v${v}`)}\n`);
  process.stderr.write(`  ${theme.muted('Stacked PRs for GitHub')}\n\n`);

  const cmds = [
    ['create [name]',           'Start a new stack'],
    ['delete [name]',           'Remove a stack from tracking'],
    ['status',                  'Show stack and PR status'],
    ['',                        ''],
    ['push',                    'Add current branch to the stack'],
    ['remove [branch]',         'Remove a branch from the stack'],
    ['nav [up|down|top|bottom]','Navigate between branches'],
    ['',                        ''],
    ['submit',                  'Push branches, create/update PRs'],
    ['absorb',                  'Route fixes to correct stack branches'],
    ['split [specs...]',        'Split changes into a stack'],
    ['restack',                 'Rebase downstream after mid-stack edits'],
    ['sync',                    'Clean up after PRs merge'],
    ['merge --all',             'Merge entire stack bottom-up'],
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

  process.stderr.write(`\n  ${theme.muted('Run any command with -h for details')}\n\n`);
  process.exit(0);
}

// Check for updates after command runs (non-blocking)
const exitCode = await cli.run(args);
const updateMsg = checkForUpdate();
if (updateMsg) {
  process.stderr.write(`\n${theme.warning(updateMsg)}\n`);
}
process.exit(exitCode);
