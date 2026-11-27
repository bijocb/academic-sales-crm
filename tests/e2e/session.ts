import path from 'node:path';

// Uses the DEMO organization from `pnpm db:seed:demo` (development data only).
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass#2026';
export const BRAND_MANAGER_STATE = path.join(__dirname, '.auth', 'brand-manager.json');
