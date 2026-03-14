Execute an implementation plan from a spec file.

Usage: /build <path-to-spec>

Read the spec file at the provided path (typically in `specs/` directory). The spec contains a detailed implementation plan with:
- Goals and requirements
- Files to create or modify
- Step-by-step implementation instructions
- Acceptance criteria

## Process

1. **Read the spec** in full before writing any code
2. **Validate** that you understand every step — ask questions if anything is ambiguous
3. **Implement** each step sequentially, checking off as you go
4. **Self-verify** after each major step:
   - Run `bunx biome check` on modified files
   - Run relevant tests if they exist
   - Verify imports and types resolve
5. **Report** what was done, what tests pass, and any issues found

## Rules

- Follow the spec exactly — don't add extras or skip steps
- If the spec is wrong or incomplete, stop and ask rather than guessing
- Commit nothing — the user will review and commit
- If a step fails, report clearly and stop rather than working around it
