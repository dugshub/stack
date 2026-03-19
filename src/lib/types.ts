export interface StackConfig {
  ai?: boolean;           // default to AI-generated PR descriptions on submit
  aiHintDismissed?: boolean;  // user dismissed the --ai tip
}

export interface StackFile {
  repo: string;
  stacks: Record<string, Stack>;
  currentStack: string | null;
  config?: StackConfig;
}

export interface Stack {
  trunk: string;
  dependsOn?: { stack: string; branch: string };
  branches: Branch[];
  created: string;
  updated: string;
  restackState: RestackState | null;
}

export interface Branch {
  name: string;
  tip: string | null;
  pr: number | null;
  parentTip: string | null;  // Parent's tip SHA when this branch was last rebased/created
}

export interface RestackState {
  fromIndex: number;
  currentIndex: number;
  oldTips: Record<string, string>;
}

export interface PrStatus {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  reviewDecision: string;
  checksStatus: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'EXPECTED' | 'ERROR' | null;
}

export type StatusEmoji =
  | '\u2705'
  | '\u274C'
  | '\uD83D\uDD28'
  | '\uD83D\uDD04'
  | '\uD83D\uDC40'
  | '\u2B1C';

export interface StackPosition {
  stackName: string;
  index: number;
  total: number;
  branch: Branch;
  isTop: boolean;
  isBottom: boolean;
}

export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface CheckResult {
	branch: string;
	index: number;
	exitCode: number;
	ok: boolean;
	durationMs: number;
}
