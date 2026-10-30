import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.claude/**', 'development/**', 'vendor/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'content.js', 'background.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, chrome: 'readonly' }
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    rules: {
      'no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_', ignoreRestSiblings: true }]
    }
  }
];
