import { Command, Option } from 'clipanion';
import * as ui from '../lib/ui.js';

export class CompletionsCommand extends Command {
	static override paths = [['completions']];

	static override usage = Command.Usage({
		description: 'Print shell completion script',
		examples: [
			['Print zsh completions', 'stack completions zsh'],
			['Print bash completions', 'stack completions bash'],
			['Install zsh completions', 'stack completions --install'],
		],
	});

	shell = Option.String({ required: false, name: 'shell' });

	install = Option.Boolean('--install', false, {
		description: 'Print installation instructions',
	});

	async execute(): Promise<number> {
		if (this.install) {
			this.showInstallInstructions();
			return 0;
		}

		const shell = this.shell ?? this.detectShell();
		if (!shell) {
			ui.error('Could not detect shell. Pass "zsh" or "bash" as an argument.');
			return 2;
		}

		switch (shell) {
			case 'zsh':
				process.stdout.write(this.zshCompletions());
				return 0;
			case 'bash':
				process.stdout.write(this.bashCompletions());
				return 0;
			default:
				ui.error(`Unsupported shell: ${shell}. Supported: zsh, bash`);
				return 2;
		}
	}

	private detectShell(): string | null {
		const shell = process.env.SHELL ?? '';
		if (shell.endsWith('/zsh')) return 'zsh';
		if (shell.endsWith('/bash')) return 'bash';
		return null;
	}

	private showInstallInstructions(): void {
		process.stderr.write(`
  Zsh:
    # Add to ~/.zshrc:
    eval "$(stack completions zsh)"

    # Or write to a file in your fpath:
    stack completions zsh > ~/.zsh/completions/_stack

  Bash:
    # Add to ~/.bashrc:
    eval "$(stack completions bash)"

    # Or write to a file:
    stack completions bash > /etc/bash_completion.d/stack
`);
	}

	private commands(): string[] {
		return [
			'abort', 'absorb', 'bottom', 'check', 'completions', 'continue',
			'create', 'daemon', 'delete', 'down', 'fold', 'graph', 'init',
			'insert', 'merge', 'modify', 'move', 'nav', 'pop', 'remove',
			'rename', 'reorder', 'restack', 'split', 'status', 'submit',
			'sync', 'top', 'track', 'undo', 'up', 'update',
		];
	}

	private zshCompletions(): string {
		const cmds = this.commands();
		return `#compdef stack

_stack() {
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
      stacks=(\${(f)"$(stack status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"})
      if [[ \${#stacks[@]} -gt 0 ]]; then
        _describe 'stack' stacks
      fi
      ;;
    args)
      case $words[1] in
        create|delete|submit|status|check|restack|sync|merge|graph)
          # Complete --stack flag values
          _arguments \\
            '--stack[Target stack by name]:stack name:->stackname' \\
            '-s[Target stack by name]:stack name:->stackname' \\
            '*::'
          if [[ $state == stackname ]]; then
            local -a stacks
            stacks=(\${(f)"$(stack status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"})
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

_stack "$@"
`;
	}

	private bashCompletions(): string {
		const cmds = this.commands();
		return `_stack() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${cmds.join(' ')}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    # Complete commands and stack names
    local stacks
    stacks="$(stack status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"
    COMPREPLY=( $(compgen -W "\${commands} \${stacks}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    completions)
      COMPREPLY=( $(compgen -W "zsh bash" -- "\${cur}") )
      ;;
    create|delete|submit|status|check|restack|sync|merge|graph)
      if [[ "\${prev}" == "--stack" || "\${prev}" == "-s" ]]; then
        local stacks
        stacks="$(stack status --json 2>/dev/null | grep -o '"[^"]*":' | head -20 | tr -d '":' || true)"
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

complete -F _stack stack
`;
	}

	private commandDescription(cmd: string): string {
		const descriptions: Record<string, string> = {
			abort: 'Abort an in-progress restack',
			absorb: 'Route fixes to correct stack branches',
			bottom: 'Jump to bottom of stack',
			check: 'Run a command on every branch',
			completions: 'Print shell completion script',
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
