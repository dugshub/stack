#!/usr/bin/env bun
import { Builtins, Cli } from 'clipanion';
import { CreateCommand } from './commands/create.js';
import { NavCommand } from './commands/nav.js';
import { PushCommand } from './commands/push.js';
import { RestackCommand } from './commands/restack.js';
import { StatusCommand } from './commands/status.js';
import { SubmitCommand } from './commands/submit.js';
import { SyncCommand } from './commands/sync.js';

const cli = new Cli({
  binaryLabel: 'stack',
  binaryName: 'stack',
  binaryVersion: '0.1.0',
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

cli.runExit(process.argv.slice(2));
