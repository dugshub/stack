export interface StackFile {
  repo: string;
  stacks: Record<string, Stack>;
}

export interface Stack {
  trunk: string;
  branches: Branch[];
  created: string;
  updated: string;
  restackState: RestackState | null;
}

export interface Branch {
  name: string;
  tip: string | null;
  pr: number | null;
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
