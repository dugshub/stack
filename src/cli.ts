#!/usr/bin/env bun
import { Builtins, Cli } from 'clipanion';
import { CreateCommand } from './commands/create.js';
import { InitCommand } from './commands/init.js';
import { NavCommand } from './commands/nav.js';
import { PushCommand } from './commands/push.js';
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
cli.register(PushCommand);
cli.register(SubmitCommand);
cli.register(RestackCommand);
cli.register(SyncCommand);
cli.register(InitCommand);
cli.register(UpdateCommand);

// Commands that don't require a git repo
const noRepoRequired = ['--help', '-h', '--version', '-v', 'help', 'version', 'update'];
const args = process.argv.slice(2);
const needsRepo = args.length > 0 && !args.some((a) => noRepoRequired.includes(a));

if (needsRepo && !git.tryRun('rev-parse', '--show-toplevel').ok) {
  ui.error('Not in a git repository.');
  process.exit(2);
}

// Check for updates after command runs (non-blocking)
const exitCode = await cli.run(args);
const updateMsg = checkForUpdate();
if (updateMsg) {
  process.stderr.write(`\n${theme.warning(updateMsg)}\n`);
}
process.exit(exitCode);
