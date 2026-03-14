# TypeScript Language Primitive — Dealbrain

Instructions for TypeScript-specific workflows in this monorepo.

## File Patterns

- Source: `**/*.ts`, `**/*.tsx`
- Tests (frontend): `**/*.test.tsx`, `**/*.test.ts` (Vitest)
- Tests (backend): `**/*.spec.ts`, `**/*.e2e-spec.ts` (Jest)
- Config: `tsconfig.json`, `biome.json`, `package.json`

## Toolchain

| Tool | Command | Scope |
|------|---------|-------|
| Lint + Format | `bunx biome check` | Both apps |
| Lint + Format (fix) | `bunx biome check --write` | Both apps |
| Typecheck (frontend) | `cd apps/frontend && bun run typecheck` | Frontend |
| Typecheck (backend) | `cd apps/backend && bun run typecheck` | Backend |
| Test (frontend) | `cd apps/frontend && bun run test` | Vitest |
| Test (backend) | `cd apps/backend && bun run test` | Jest |
| Build (frontend) | `cd apps/frontend && bun run build` | Vite |
| Build (backend) | `cd apps/backend && bun run build` | NestJS |
| Combined check | `bun run check` (per app) | Lint + format + typecheck |

## Conventions

- **Strict mode** — `strict: true`, `noUncheckedIndexedAccess` enabled
- **No `any`** — Use generics, `unknown` with type guards, or proper types
- **No `biome-ignore`** — Fix the underlying issue
- **Import dependency types** — Don't redefine types that packages already export
- **Biome formatting** — 2-space indent, single quotes, recommended rules
- **Package manager** — `bun` only (not npm, pnpm, yarn)

## Frontend-Specific

- React 19 with `forwardRef` + `displayName` on all components
- CVA (Class Variance Authority) for component variants
- TailwindCSS v4 with design tokens from `tokens.css`
- TanStack Router (file-based routing, `routeTree.gen.ts` is auto-generated)
- TanStack DB + Electric SQL for real-time data
- Vitest + React Testing Library (behavioral tests, roles/text not classes)

## Backend-Specific

- NestJS with dependency injection
- tRPC v11 for type-safe API
- Jest + ts-jest for unit/integration tests
- BullMQ for background jobs
- Pino for structured logging

## Strategy Considerations

When planning TypeScript implementations:
- Check existing patterns in the atomic design system (atoms → molecules → organisms)
- Frontend components colocate: `.tsx`, `.types.ts`, `.variants.ts`, `.test.tsx`, `index.ts`
- Backend follows NestJS module pattern: controller → service → repository
- Shared types live in `@repo/db` (Zod schemas) and `@repo/trpc` (router/client)
