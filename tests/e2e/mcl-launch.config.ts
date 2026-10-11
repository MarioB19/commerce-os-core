import {defineConfig,devices} from '@playwright/test';
// Isolated UI fixtures; all API requests are intercepted. No workers or sends.
export default defineConfig({testDir:'.',testMatch:'mcl-launch.spec.ts',workers:1,timeout:45000,expect:{timeout:10000},reporter:'list',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1000},baseURL:'http://127.0.0.1:5189',trace:'off',screenshot:'only-on-failure',video:'off'},webServer:{command:'pnpm --filter @commerce/web dev --port 5189 --strictPort',url:'http://127.0.0.1:5189',reuseExistingServer:false,timeout:30000}});
