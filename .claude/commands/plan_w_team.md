Create an implementation plan using the builder+validator agent team pattern.

## Process

1. **Research Phase** (you, the coordinator):
   - Understand the request
   - Read relevant files and understand the codebase context
   - Identify the scope of changes needed

2. **Planning Phase** (you):
   - Draft an implementation spec (see `/plan` format)
   - Write it to `specs/<date>-<kebab-case-name>.md`

3. **Validation Phase** (validator agent):
   - Delegate to the `validator` agent to review the plan
   - The validator checks for:
     - Completeness (any missing steps?)
     - Correctness (will this actually work?)
     - Conflicts (does it break existing code?)
     - Minimal scope (is anything unnecessary?)
   - Incorporate validator feedback into the spec

4. **Execution Phase** (builder agent):
   - Delegate implementation to the `builder` agent with the finalized spec
   - Builder implements step by step

5. **Review Phase** (validator agent):
   - Delegate final review to the `validator` agent
   - Validator runs tests, lint, and type checks
   - Reports any issues for the builder to fix

## Output

After the full cycle, report:
- What was planned
- What was built
- What the validator found
- Final status (PASS/FAIL)
