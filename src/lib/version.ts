import { homedir } from 'node:os';
import { join } from 'node:path';

const pkgPath = new URL('../../package.json', import.meta.url).pathname;
const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf-8'));
const VERSION: string = pkg.version ?? '0.0.0';
const REPO = 'dugshub/stack';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CHECK_FILE = join(homedir(), '.claude', 'stack-update-check.json');

export function currentVersion(): string {
  return VERSION;
}

interface CheckState {
  lastCheck: number;
  remoteVersion: string | null;
}

function readCheckState(): CheckState | null {
  try {
    const file = Bun.file(CHECK_FILE);
    // Bun.file doesn't throw on missing files, but .json() will
    const text = readFileSync(CHECK_FILE);
    if (!text) return null;
    return JSON.parse(text) as CheckState;
  } catch {
    return null;
  }
}

function readFileSync(path: string): string | null {
  const result = Bun.spawnSync(['cat', path], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString();
}

function writeCheckState(state: CheckState): void {
  try {
    Bun.write(CHECK_FILE, JSON.stringify(state));
  } catch {
    // Non-critical, ignore
  }
}

function fetchRemoteVersion(): string | null {
  const result = Bun.spawnSync(
    ['gh', 'api', `repos/${REPO}/contents/package.json`, '-q', '.content'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) return null;
  try {
    const decoded = atob(result.stdout.toString().trim());
    const pkg = JSON.parse(decoded) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

/** Check for updates (throttled). Returns a message string if update available, null otherwise. */
export function checkForUpdate(): string | null {
  const state = readCheckState();
  const now = Date.now();

  // Use cached result if recent enough
  if (state && now - state.lastCheck < CHECK_INTERVAL_MS) {
    if (state.remoteVersion && isNewer(state.remoteVersion, VERSION)) {
      return updateMessage(state.remoteVersion);
    }
    return null;
  }

  // Fetch fresh
  const remoteVersion = fetchRemoteVersion();
  writeCheckState({ lastCheck: now, remoteVersion });

  if (remoteVersion && isNewer(remoteVersion, VERSION)) {
    return updateMessage(remoteVersion);
  }
  return null;
}

function updateMessage(remoteVersion: string): string {
  return `Update available: ${VERSION} → ${remoteVersion} (run \`st update\`)`;
}
