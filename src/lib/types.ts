export interface StackConfig {
	describe?: boolean;
	describeHintDismissed?: boolean;
	commentDepth?: number;
}

export interface StackFile {
  repo: string;
  stacks: Record<string, Stack>;
  currentStack: string | null;
  config?: StackConfig;
}

export interface StackParent {
  stack: string;
  branch: string;
}

export interface Stack {
  trunk: string;
  dependsOn?: StackParent[];
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
  /** Join branch only: map of parent-branch-name → tip at last join-rebase. */
  parentTips?: Record<string, string>;
  /** Join branch only: SHA of the octopus/merge commit itself. */
  joinMergeSha?: string;
}

export interface JoinRestackState {
  branchName: string;
  phase: 'merging' | 'replaying';
  /** Branch HEAD before the restart (pre-rebase tip of the join branch). */
  oldJoinTip: string;
  /** Pre-restack merge commit SHA. */
  oldMergeSha: string;
  /** Filled once the re-merge completes. */
  newMergeSha?: string;
  /** New tips we're targeting (by parent branch name). */
  parentTipsAtStart: Record<string, string>;
}

export interface RestackState {
  fromIndex: number;
  currentIndex: number;
  oldTips: Record<string, string>;
  /** Set while a diamond join-branch rebase is in progress. */
  joinState?: JoinRestackState;
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
