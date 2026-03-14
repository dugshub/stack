import pc from 'picocolors';
import type { Formatter } from 'picocolors/types';

// ── Palette ─────────────────────────────────────────────
// Raw colors. Change these to retheme the entire CLI.
// Everything below references the palette, never raw colors.

const palette = {
	// Core spectrum
	c1: pc.cyan,
	c2: pc.magenta,
	c3: pc.yellow,
	c4: pc.blue,
	c5: pc.white,
	c6: pc.dim,

	// Status
	good: pc.green,
	warn: pc.yellow,
	bad: pc.red,

	// Modifiers
	bold: pc.bold,
	dim: pc.dim,
	underline: pc.underline,
};

// ── Theme ───────────────────────────────────────────────
// Semantic roles → palette mappings. To change what "branch"
// looks like, point it at a different palette color.

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
	// Status
	success: palette.good,
	warning: palette.warn,
	error: palette.bad,

	// Emphasis
	muted: palette.dim,
	emphasis: palette.bold,
	accent: palette.c1,

	// Elements
	branch: palette.c1,
	stack: palette.c2,
	pr: palette.c3,
	command: palette.c1,
	label: palette.bold,
};

export const theme = defaultTheme;
