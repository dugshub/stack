# Fast Quality Profile — Dealbrain

Minimal quality gates for rapid iteration. Typecheck is still required (strict mode is non-negotiable).

## Gates

| Gate | Command | Blocking |
|------|---------|----------|
| Lint + Format | `bunx biome check apps/{app}/src` | Yes |
| Typecheck | `bun run typecheck` (per affected app) | Yes |
| Unit Tests | Run only for changed files | No |
| Build | Optional | No |

## Testing Requirements

- Tests for complex logic only
- Happy path coverage sufficient
- Skip integration tests

## When to Use

- Prototypes and spikes
- Internal tooling changes
- Documentation-only changes
- Early development on new features

## Upgrade Path

When code stabilizes, upgrade to `strict`:
1. Add missing tests
2. Run full build
3. Verify all gates pass
