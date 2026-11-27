/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|int-spec)\\.ts$',
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  moduleNameMapper: { '^@crm/contracts$': '<rootDir>/../../packages/contracts/src' },
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
  // Integration suites share one database; run files one at a time.
  maxWorkers: 1,
};
