#!/usr/bin/env bun
import { Builtins, Cli } from 'clipanion';
import { CreateCommand } from './commands/create.js';
import { NavCommand } from './commands/nav.js';
import { PushCommand } from './commands/push.js';
import { RestackCommand } from './commands/restack.js';
import { StatusCommand } from './commands/status.js';
import { SubmitCommand } from './commands/submit.js';
import { SyncCommand } from './commands/sync.js';
import { UpdateCommand } from './commands/update.js';
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
cli.register(UpdateCommand);

// Check for updates after command runs (non-blocking)
const exitCode = await cli.run(process.argv.slice(2));
const updateMsg = checkForUpdate();
if (updateMsg) {
  process.stderr.write(`\n\x1b[33m${updateMsg}\x1b[0m\n`);
}
process.exit(exitCode);
