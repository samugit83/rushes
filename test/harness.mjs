// The assertions, in their own module so a test file importing them does not
// import the runner that is importing the test file.

const state = { passed: 0, failed: 0, failures: [] };

export async function test(name, fn) {
  try {
    await fn();
    state.passed++;
    process.stderr.write(`  ✓ ${name}\n`);
  } catch (e) {
    state.failed++;
    state.failures.push({ name, error: e });
    process.stderr.write(`  ✗ ${name}\n    ${e?.message ?? e}\n`);
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(message ?? 'assertion failed');
}

export function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? 'not equal'}\n      actual:   ${a}\n      expected: ${b}`);
}

export function near(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message ?? 'out of tolerance'}: ${actual} is more than ${tolerance} from ${expected}`);
  }
}

export function results() { return state; }
