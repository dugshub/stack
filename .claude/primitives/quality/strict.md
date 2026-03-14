# Strict Quality Profile — Dealbrain

All quality gates must pass before PR.

## Gates

| Gate | Command | Blocking |
|------|---------|----------|
| Lint + Format | `bunx biome check apps/{app}/src` | Yes |
| Typecheck (frontend) | `cd apps/frontend && bun run typecheck` | Yes |
| Typecheck (backend) | `cd apps/backend && bun run typecheck` | Yes |
| Unit Tests (frontend) | `cd apps/frontend && bun run test` | Yes |
| Unit Tests (backend) | `cd apps/backend && bun run test` | Yes |
| Build (frontend) | `cd apps/frontend && bun run build` | Yes |
| Build (backend) | `cd apps/backend && bun run build` | Yes |

## Testing Requirements

- Unit tests for all new functions and components
- Behavioral tests (React Testing Library — roles/text, not class names)
- Backend integration tests for API endpoints (Jest + TestContainers)
- Edge cases explicitly tested
- Error paths covered

## When to Use

- All production PRs
- Shared library changes (`@repo/db`, `@repo/trpc`)
- Any change to auth, data sync, or API surface

## Strategy Implications

When planning with strict quality:
- Budget for comprehensive tests following existing patterns
- Frontend: Vitest + RTL behavioral tests
- Backend: Jest + TestContainers (Postgres + Electric + KMS)
- Run `bun run check` in each affected app before declaring done
