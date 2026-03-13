#!/usr/bin/env bun
import { Builtins, Cli } from 'clipanion';
import { NavCommand } from './commands/nav.js';
import { StatusCommand } from './commands/status.js';

const cli = new Cli({
  binaryLabel: 'stack',
  binaryName: 'stack',
  binaryVersion: '0.1.0',
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.register(StatusCommand);
cli.register(NavCommand);

cli.runExit(process.argv.slice(2));
