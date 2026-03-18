interface ParsedBranch {
  user: string;
  stack: string;
  index: number;
  description: string;
}

export function parseBranchName(name: string): ParsedBranch | null {
  // Pattern: user/stack/N-description
  const match = name.match(/^([^/]+)\/([^/]+)\/(\d+)-(.+)$/);
  if (!match) return null;
  const user = match[1];
  const stack = match[2];
  const indexStr = match[3];
  const description = match[4];
  if (!user || !stack || !indexStr || !description) return null;
  return {
    user,
    stack,
    index: Number.parseInt(indexStr, 10),
    description,
  };
}

export function buildBranchName(
  user: string,
  stack: string,
  index: number,
  description: string,
): string {
  return `${user}/${stack}/${index}-${description}`;
}

export function descriptionToTitle(description: string): string {
  return description
    .split('-')
    .map((word) => {
      if (word.length === 0) return word;
      const first = word[0];
      if (!first) return word;
      return first.toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const RESERVED_NAMES = new Set([
  'abort', 'absorb', 'bottom', 'check', 'continue', 'create', 'daemon',
  'delete', 'down', 'fold', 'graph', 'help', 'init', 'insert', 'merge',
  'modify', 'move', 'nav', 'pop', 'remove', 'rename', 'reorder',
  'restack', 'split', 'status', 'submit', 'sync', 'top', 'track',
  'undo', 'up', 'update', 'version',
]);

export function validateStackName(name: string): {
  valid: boolean;
  error?: string;
} {
  if (name.length === 0) {
    return { valid: false, error: 'Stack name cannot be empty' };
  }
  if (name.includes('/')) {
    return { valid: false, error: 'Stack name cannot contain slashes' };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return {
      valid: false,
      error:
        'Stack name must be kebab-case (lowercase letters, numbers, hyphens)',
    };
  }
  if (RESERVED_NAMES.has(name)) {
    return {
      valid: false,
      error: `"${name}" is reserved (conflicts with a command)`,
    };
  }
  if (/^\d+$/.test(name)) {
    return {
      valid: false,
      error: `"${name}" is a reserved name (conflicts with branch jump syntax)`,
    };
  }
  return { valid: true };
}
