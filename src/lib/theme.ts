import { isatty } from 'node:tty';
import { createColors } from 'picocolors';
import type { Formatter } from 'picocolors/types';

// All CLI output goes to stderr (fd 2). Use node:tty.isatty() for reliable
// detection — process.stderr.isTTY can be undefined in Bun global installs.
const colorEnabled =
	!process.env.NO_COLOR &&
	(!!process.env.FORCE_COLOR || isatty(2));
const pc = createColors(colorEnabled);

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

/** Wrap text in an OSC 8 hyperlink (clickable in supported terminals). */
export function link(text: string, url: string): string {
	if (!colorEnabled) return text;
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
