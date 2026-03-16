export function formatRelativeTime(isoString: string): string {
	const then = new Date(isoString).getTime();
	const now = Date.now();
	const diffMs = now - then;
	const diffMinutes = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffMinutes < 1) return 'just now';
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	return `${diffDays}d ago`;
}
