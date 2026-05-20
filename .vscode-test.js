const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig([
  {
    label: 'integration',
    files: 'out/test/suite/**/*.test.js',
    version: 'stable',
    mocha: {
      ui: 'tdd',
      timeout: 20000
    }
  }
]);
