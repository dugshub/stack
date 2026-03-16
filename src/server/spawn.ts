export interface SpawnResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export async function execAsync(
	cmd: string[],
	opts?: { cwd?: string },
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, {
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: opts?.cwd,
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return {
		ok: exitCode === 0,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
	};
}

export function ghAsync(...args: string[]): Promise<SpawnResult> {
	return execAsync(['gh', ...args]);
}

export function gitAsync(
	args: string[],
	opts?: { cwd?: string },
): Promise<SpawnResult> {
	return execAsync(['git', ...args], opts);
}
