# Systematic Debugging Methodology

When encountering bugs or unexpected behavior, follow this structured 4-phase approach:

## Phase 1: Reproduce
1. **Confirm the bug exists** - Can you reliably reproduce it?
2. **Document the symptoms** - What exactly happens vs. what should happen?
3. **Identify the trigger** - What specific conditions cause the bug?

## Phase 2: Isolate
1. **Narrow the scope** - Which component/function is responsible?
2. **Create a minimal reproduction** - Simplest case that triggers the bug
3. **Add diagnostic logging** - Strategic console.log/debug statements

## Phase 3: Root Cause Analysis
1. **Trace the execution path** - Follow the data flow step by step
2. **Check assumptions** - Are inputs what you expect? Are types correct?
3. **Look for patterns** - Does it fail consistently or intermittently?
4. **Review recent changes** - What changed since it last worked?

## Phase 4: Fix and Verify
1. **Write a failing test** - Capture the bug in an automated test
2. **Implement the fix** - Address the root cause, not just symptoms
3. **Verify the fix** - Test passes, bug no longer reproducible
4. **Defense in depth** - Add guards to prevent similar issues

## Rules
- **Evidence over assumptions** - Verify every hypothesis with actual data
- **One change at a time** - Don't make multiple changes simultaneously
- **Document findings** - Record what you learned for future reference
- **No random guessing** - Systematic investigation, not trial-and-error
