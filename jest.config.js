module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  // Pins database URLs before any module loads, so a suite cannot inherit
  // production credentials from .env via db/pool's dotenv call. See the file
  // for why this also removes the intermittent pg teardown failure.
  setupFiles: ['<rootDir>/jest.setup.env.js'],
  verbose: true,
  forceExit: true,
  detectOpenHandles: true,
};
