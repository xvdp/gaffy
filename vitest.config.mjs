// Test files live in test/; scratch folders (.preview, dist) are not scanned.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
