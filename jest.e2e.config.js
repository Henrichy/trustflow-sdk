const base = require('./jest.config');

/** End-to-end project: runs against a live Stellar network (see CONTRIBUTING.md). */
module.exports = {
  ...base,
  testEnvironment: 'node',
  testMatch: ['**/tests/e2e/**/*.e2e.test.ts'],
  passWithNoTests: true,
  testTimeout: 120_000,
};
