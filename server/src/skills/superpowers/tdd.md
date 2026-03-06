# Test-Driven Development (TDD) Methodology

Follow the RED-GREEN-REFACTOR cycle strictly:

## The Cycle

### 1. RED - Write a Failing Test First
- Write a test that describes the expected behavior
- Run the test and verify it fails
- The test should fail for the right reason (not syntax errors)

### 2. GREEN - Write Minimal Code to Pass
- Write the simplest code that makes the test pass
- Don't over-engineer or add unnecessary features
- Run the test and verify it passes

### 3. REFACTOR - Improve the Code
- Clean up the implementation while keeping tests green
- Remove duplication, improve naming, simplify logic
- Run tests after each refactoring step

## Rules
- **Never write production code without a failing test first**
- **Code written before tests must be deleted and rewritten with TDD**
- **One assertion per test when possible**
- **Tests should be independent and isolated**
- **Run the full test suite before committing**

## When to Apply
- New features: Always use TDD
- Bug fixes: Write a test that reproduces the bug first
- Refactoring: Ensure tests exist before refactoring

## Verification
After each cycle:
1. Confirm test fails before implementation (RED)
2. Confirm test passes after implementation (GREEN)
3. Confirm all tests still pass after refactoring
