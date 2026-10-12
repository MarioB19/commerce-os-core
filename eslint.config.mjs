import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['portals/**','**/dist/**','**/node_modules/**','test-results/**','test-evidence/**','playwright-report/**','.runtime/**','.local/**','apps/commerce-desktop/src-tauri/target/**','apps/commerce-desktop/src-tauri/resources/runtime/**','apps/commerce-desktop/src-tauri/gen/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx,js,mjs}'], languageOptions: { globals: {...globals.node,...globals.browser} }, rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}],
    'no-constant-condition': ['error',{checkLoops:false}]
  }}
);
