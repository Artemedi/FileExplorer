import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: false,
        include: ['tests/**/*.test.{js,jsx,ts,tsx}'],
        exclude: ['tests/codebase_audit.test.mjs', 'node_modules/**', 'dist/**'],
    },
});
