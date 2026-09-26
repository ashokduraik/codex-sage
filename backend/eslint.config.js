import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

/** ESLint flat config for the standalone Node backend package. */
export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Application config must be loaded only via platform/config.js.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read environment variables only in src/platform/config.js',
        },
      ],
    },
  },
  {
    files: ['src/platform/config.js', 'tests/**/*.test.js'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  eslintConfigPrettier,
];
