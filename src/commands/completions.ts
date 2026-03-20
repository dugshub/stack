import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'clipanion';
import { theme } from '../lib/theme.js';
import * as ui from '../lib/ui.js';

export class CompletionsCommand extends Command {
	static override paths = [['completions']];

	static override usage = Command.Usage({
		description: 'Print shell completion script',
		examples: [
			['Print zsh completions', 'st completions zsh'],
			['Print bash completions', 'st completions bash'],
			['Install zsh completions', 'st completions --install'],
		],
	});

	shell = Option.String({ required: false, name: 'shell' });

	install = Option.Boolean('--install', false, {
		description: 'Print installation instructions',
	});

	async execute(): Promise<number> {
		// If a shell arg is given, print raw script (for piping / eval)
		if (this.shell) {
			switch (this.shell) {
				case 'zsh':
					process.stdout.write(this.zshCompletions());
					return 0;
				case 'bash':
					process.stdout.write(this.bashCompletions());
					return 0;
				default:
					ui.error(`Unsupported shell: ${this.shell}. Supported: zsh, bash`);
					return 2;
			}
		}

		// Bare `st completions` or `--install` → auto-install
		return this.autoInstall();
	}

	private autoInstall(): number {
		const shell = this.detectShell();
		if (!shell) {
			ui.error('Could not detect shell. Only zsh and bash are supported.');
			return 2;
		}

		const marker = '# st completions';
		const oldMarker = '# stack completions';

		if (shell === 'zsh') {
			// Write completion function to ~/.zfunc/_st
			const zfuncDir = join(homedir(), '.zfunc');
			mkdirSync(zfuncDir, { recursive: true });
			writeFileSync(join(zfuncDir, '_st'), this.zshCompletions(), 'utf-8');

			// Ensure fpath + compinit in .zshrc (migrate from old patterns)
			const rcPath = join(homedir(), '.zshrc');
			let rc = existsSync(rcPath) ? readFileSync(rcPath, 'utf-8') : '';
			const fpathSnippet = `${marker}\nfpath=(~/.zfunc $fpath)\nautoload -Uz compinit && compinit`;

			// Remove old stack completions if present
			if (rc.includes(oldMarker)) {
				const lines = rc.split('\n');
				const filtered: string[] = [];
				let skip = false;
				for (const line of lines) {
					if (line.trim() === oldMarker) {
						skip = true;
						continue;
					}
					if (skip && (line.startsWith('fpath=') || line.startsWith('autoload') || line.startsWith('eval "$(stack'))) {
						continue;
					}
					skip = false;
					filtered.push(line);
				}
				rc = filtered.join('\n');
			}

			if (!rc.includes(marker)) {
				writeFileSync(rcPath, `${rc}\n${fpathSnippet}\n`, 'utf-8');
			}
			ui.success('Installed completions to ~/.zfunc/_st');
			ui.info('Open a new terminal to activate.');
			return 0;
		}

		if (shell === 'bash') {
			const rcPath = join(homedir(), '.bashrc');
			let rc = existsSync(rcPath) ? readFileSync(rcPath, 'utf-8') : '';

			// Remove old stack completions if present
			if (rc.includes(oldMarker)) {
				const lines = rc.split('\n');
				const filtered: string[] = [];
				let skip = false;
				for (const line of lines) {
					if (line.trim() === oldMarker) {
						skip = true;
						continue;
					}
					if (skip && line.startsWith('eval "$(stack')) {
						continue;
					}
					skip = false;
					filtered.push(line);
				}
				rc = filtered.join('\n');
			}

			if (rc.includes(marker)) {
				ui.info('Completions already installed in ~/.bashrc');
				return 0;
			}
			const snippet = `\n${marker}\neval "$(st completions bash)"\n`;
			writeFileSync(rcPath, rc + snippet, 'utf-8');
			ui.success('Installed completions in ~/.bashrc');
			ui.info(`Run ${theme.command('source ~/.bashrc')} or open a new terminal.`);
			return 0;
		}

		return 2;
	}

	private detectShell(): string | null {
		const shell = process.env.SHELL ?? '';
		if (shell.endsWith('/zsh')) return 'zsh';
		if (shell.endsWith('/bash')) return 'bash';
		return null;
	}

	private topLevelCommands(): string[] {
		return [
			'stack', 's', 'branch', 'b',
			'abort', 'absorb', 'bottom', 'check', 'completions', 'config', 'continue',
			'create', 'daemon', 'delete', 'down', 'fold', 'graph', 'init',
			'insert', 'merge', 'modify', 'move', 'nav', 'pop', 'remove',
			'rename', 'reorder', 'restack', 'split', 'status', 'submit',
			'sync', 'top', 'track', 'undo', 'up', 'update',
		];
	}

	private stackSubcommands(): string[] {
		return ['create', 'delete', 'status', 'submit', 'sync', 'merge', 'restack', 'check', 'graph'];
	}

	private branchSubcommands(): string[] {
		return [
			'up', 'down', 'top', 'bottom', 'nav', 'track', 'remove', 'pop',
			'fold', 'rename', 'move', 'insert', 'reorder', 'modify', 'absorb', 'split',
		];
	}

	private zshCompletions(): string {
		const cmds = this.topLevelCommands();
		const stackSubs = this.stackSubcommands();
		const branchSubs = this.branchSubcommands();
		return `#compdef st

_st() {
  local -a commands
  commands=(
${cmds.map(c => `    '${c}:${this.commandDescription(c)}'`).join('\n')}
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      # Also complete stack names
      local -a stacks
      stacks=(\${(f)"$(st status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"})
      if [[ \${#stacks[@]} -gt 0 ]]; then
        _describe 'stack' stacks
      fi
      ;;
    args)
      case $words[1] in
        stack|s)
          local -a stack_cmds
          stack_cmds=(
${stackSubs.map(c => `            '${c}:${this.commandDescription(c)}'`).join('\n')}
          )
          _describe 'stack command' stack_cmds
          ;;
        branch|b)
          local -a branch_cmds
          branch_cmds=(
${branchSubs.map(c => `            '${c}:${this.commandDescription(c)}'`).join('\n')}
          )
          _describe 'branch command' branch_cmds
          ;;
        create|delete|submit|status|check|restack|sync|merge|graph)
          # Complete --stack flag values
          _arguments \\
            '--stack[Target stack by name]:stack name:->stackname' \\
            '-s[Target stack by name]:stack name:->stackname' \\
            '*::'
          if [[ $state == stackname ]]; then
            local -a stacks
            stacks=(\${(f)"$(st status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"})
            _describe 'stack' stacks
          fi
          ;;
        completions)
          _arguments '1:shell:(zsh bash)'
          ;;
      esac
      ;;
  esac
}

_st "$@"
`;
	}

	private bashCompletions(): string {
		const cmds = this.topLevelCommands();
		const stackSubs = this.stackSubcommands();
		const branchSubs = this.branchSubcommands();
		return `_st() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${cmds.join(' ')}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    # Complete commands and stack names
    local stacks
    stacks="$(st status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"
    COMPREPLY=( $(compgen -W "\${commands} \${stacks}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    stack|s)
      COMPREPLY=( $(compgen -W "${stackSubs.join(' ')}" -- "\${cur}") )
      ;;
    branch|b)
      COMPREPLY=( $(compgen -W "${branchSubs.join(' ')}" -- "\${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "zsh bash" -- "\${cur}") )
      ;;
    create|delete|submit|status|check|restack|sync|merge|graph)
      if [[ "\${prev}" == "--stack" || "\${prev}" == "-s" ]]; then
        local stacks
        stacks="$(st status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"
        COMPREPLY=( $(compgen -W "\${stacks}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "--stack -s --help -h" -- "\${cur}") )
      fi
      ;;
    *)
      COMPREPLY=( $(compgen -W "--help -h" -- "\${cur}") )
      ;;
  esac
}

complete -F _st st
complete -F _st stack
`;
	}

	private commandDescription(cmd: string): string {
		const descriptions: Record<string, string> = {
			stack: 'Stack operations',
			s: 'Shorthand for stack',
			branch: 'Branch operations',
			b: 'Shorthand for branch',
			abort: 'Abort an in-progress restack',
			absorb: 'Route fixes to correct stack branches',
			bottom: 'Jump to bottom of stack',
			check: 'Run a command on every branch',
			completions: 'Print shell completion script',
			config: 'View or update settings',
			continue: 'Continue after resolving conflicts',
			create: 'Create a new stack',
			daemon: 'Manage background daemon',
			delete: 'Remove a stack',
			down: 'Move down one branch',
			fold: 'Fold branch into parent',
			graph: 'Show dependency graph',
			init: 'Install Claude Code skills',
			insert: 'Insert a new branch at position',
			merge: 'Merge entire stack',
			modify: 'Amend and restack',
			move: 'Move a branch within the stack',
			nav: 'Interactive branch picker',
			pop: 'Pop branch, keep changes',
			remove: 'Remove a branch from the stack',
			rename: 'Rename current branch',
			reorder: 'Reorder branches',
			restack: 'Rebase downstream branches',
			split: 'Split changes into a stack',
			status: 'Show stack and PR status',
			submit: 'Push and create/update PRs',
			sync: 'Clean up after merges',
			top: 'Jump to top of stack',
			track: 'Add current branch to a stack',
			undo: 'Undo last command',
			up: 'Move up one branch',
			update: 'Self-update to latest version',
		};
		return descriptions[cmd] ?? '';
	}
}
