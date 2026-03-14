import pc from 'picocolors';
import type { Formatter } from 'picocolors/types';

export interface Theme {
	// Status indicators
	success: Formatter;
	warning: Formatter;
	error: Formatter;

	// Content emphasis
	muted: Formatter;
	emphasis: Formatter;
	accent: Formatter;

	// Semantic elements
	branch: Formatter;
	stack: Formatter;
	pr: Formatter;
	command: Formatter;
	label: Formatter;
}

const defaultTheme: Theme = {
	success: pc.green,
	warning: pc.yellow,
	error: pc.red,

	muted: pc.dim,
	emphasis: pc.bold,
	accent: pc.cyan,

	branch: pc.bold,
	stack: pc.bold,
	pr: pc.cyan,
	command: pc.cyan,
	label: pc.bold,
};

export const theme = defaultTheme;
