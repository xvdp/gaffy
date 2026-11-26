// npm run providers -- [folder]: bundles and runs scripts/providers.ts (language providers outside VS Code)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('dist', { recursive: true });
await esbuild.build({ entryPoints: ['scripts/providers.ts'], outfile: 'dist/providers.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'warning' });
try {
    execFileSync(process.execPath, ['dist/providers.cjs', ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (e) { process.exit(e.status ?? 1); }
