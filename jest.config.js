/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts', // Express bootstrap — not unit-testable without a running server
  ],
  coverageThresholds: {
    global: {
      lines: 95,
      functions: 95,
      branches: 90,
      statements: 95,
    },
  },
};
