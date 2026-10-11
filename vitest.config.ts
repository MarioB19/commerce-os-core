import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['packages/**/*.test.ts','apps/**/*.test.ts','tests/unit/**/*.test.ts'],exclude:['**/node_modules/**','**/dist/**'],testTimeout:15000}});
