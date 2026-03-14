# PR 0.1: EntityRelationRepository — Spec

## Overview

Extract a generic M:N junction table repository from `OpportunityContactRepository` and `OpportunityMeetingRepository`. Both repos implement identical logic (composite PK upsert, find-by-side queries) differing only in table and column names. A single config-driven generic replaces both.

## Architecture

```
IEntityRelationRepository (domain interface)
        ↑ implements
EntityRelationRepository (infrastructure — generic, config-driven)
        ↑ instantiated as
  ├── OPPORTUNITY_CONTACT_REPOSITORY (config: opportunityContacts table)
  └── OPPORTUNITY_MEETING_REPOSITORY (config: opportunityMeetings table)
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/domain/entity-relation-repository.interface.ts` | create | Generic interface + link type |
| `src/infrastructure/database/repositories/entity-relation.repository.ts` | create | Generic implementation |
| `src/infrastructure/database/repositories/entity-relation.repository.spec.ts` | create | Tests for generic repo |
| `src/domain/opportunities/opportunity-contact.repository.interface.ts` | modify | Re-export from generic |
| `src/domain/meetings/opportunity-meeting.repository.interface.ts` | modify | Re-export from generic |
| `src/infrastructure/database/repositories/opportunity-contact.repository.ts` | delete | Replaced by generic |
| `src/infrastructure/database/repositories/opportunity-meeting.repository.ts` | delete | Replaced by generic |
| `src/infrastructure/database/repositories/opportunity-contact.repository.spec.ts` | delete | Replaced by generic test |
| `src/infrastructure/modules/opportunities.module.ts` | modify | Use factory registration |
| `src/infrastructure/modules/meetings.module.ts` | modify | Use factory registration |
| `src/infrastructure/database/repositories/index.ts` | modify | Update barrel exports |

## Interface

```typescript
// domain/entity-relation-repository.interface.ts
export interface EntityRelationLink {
  leftId: string;
  rightId: string;
}

export interface IEntityRelationRepository {
  upsertLinks(links: EntityRelationLink[]): Promise<number>;
  findByLeft(leftId: string): Promise<string[]>;
  findByRight(rightId: string): Promise<string[]>;
}
```

```typescript
// infrastructure/database/repositories/entity-relation.repository.ts
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

interface EntityRelationConfig {
  leftColumn: PgColumn;
  rightColumn: PgColumn;
}

@Injectable()
class EntityRelationRepository implements IEntityRelationRepository {
  constructor(
    db: DrizzleDB,
    table: PgTable,
    config: EntityRelationConfig,
  ) {}
}
```

## Backward Compatibility

The consumers of these repos use two shapes:

1. **OpportunityContactRepository** — `upsertLinks(links: OpportunityContactLink[])` and `findLinksByContactIds(contactIds: string[])`
2. **OpportunityMeetingRepository** — `upsertLinks(links: OpportunityMeetingLink[])`

The generic interface uses `{ leftId, rightId }` instead of `{ opportunityId, contactId }`. To avoid touching all 4 consumer files in this PR, the domain interface files will re-export adapted types:

- `IOpportunityContactRepository` stays the same interface shape
- `IOpportunityMeetingRepository` stays the same interface shape
- The module registration adapts the generic into the existing contract via thin wrappers or factory adapters

**Simpler approach**: Since the consumers only use `upsertLinks` and `findLinksByContactIds`, and the generic can support both, we can create factory functions that return an EntityRelationRepository instance wrapped to match the existing interfaces.

Actually, simplest approach: modify the existing domain interfaces to use the generic, and update the 4 consumer call sites to use the generic shape. The consumers are:
- `ImportOpportunitiesUseCase` — calls `upsertLinks`
- `MatchMeetingOpportunitiesUseCase` — calls `findLinksByContactIds`
- `SyncCalendarMeetingsForUserEventHandler` — calls `upsertLinks`

## Implementation Steps

1. Create `IEntityRelationRepository` interface in `domain/`
2. Create `EntityRelationRepository` generic class in `infrastructure/database/repositories/`
3. Create test for EntityRelationRepository
4. Update `IOpportunityContactRepository` → alias for `IEntityRelationRepository` + `OpportunityContactLink` mapped from generic
5. Update `IOpportunityMeetingRepository` → alias for `IEntityRelationRepository` + `OpportunityMeetingLink` mapped from generic
6. Update DI registrations in opportunities.module.ts and meetings.module.ts to use factories
7. Update consumer call sites to use generic method names
8. Delete old concrete repo files + old spec
9. Update barrel exports
10. Run tests
