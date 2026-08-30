const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/**
 * Pass 25 — Testing.
 *
 * `testPathIgnorePatterns` excludes `src/__tests__/integration` — see that directory's
 * own README for why: this app has no test database reachable from any environment
 * this test suite has been written/run in, so integration tests that would need one
 * are documented as a template, not written as runnable specs that would just fail on
 * every machine without a Postgres instance configured for testing.
 */
/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    ...tsJestTransformCfg,
  },
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/src/__tests__/integration/", "/src/__tests__/unit/stateMachineTestHelpers.ts"],
  collectCoverageFrom: [
    "src/app/modules/**/*-lifecycle.ts",
    "src/app/modules/**/*-state-machine.ts",
    "src/app/modules/**/*.validation.ts",
    "src/shared/money.ts",
    "src/shared/trackingId.ts",
  ],
};