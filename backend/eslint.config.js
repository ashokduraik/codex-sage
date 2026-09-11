import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** ESLint flat config for the standalone Node backend package. */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Application config must be loaded only via platform/config.ts.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read environment variables only in src/platform/config.ts',
        },
      ],
    },
  },
  {
    files: ['src/platform/config.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);
