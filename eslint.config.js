import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
export default ts.config(
  { ignores: ['dist/**', 'src-tauri/target/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  { files: ['src/**/*.{ts,tsx}'], extends: [js.configs.recommended, ...ts.configs.recommended], languageOptions: { globals: globals.browser }, plugins: { 'react-hooks': hooks, 'jsx-a11y': a11y }, rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error', ...a11y.configs.recommended.rules, '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['region'] }] } }
);
