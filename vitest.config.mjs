// Test files live in test/; scratch folders (.preview, dist) are not scanned.
// testTimeout 60 s: the layout tests that build many scenes (test/matrix.test.ts grouping and operation sequences,
// test/edges.test.ts search again) take 1 to 4 s here and exceed vitest's 5 s default on slower machines.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60_000 } });
