import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.each([{ exactAudioRequired: true }, { exactVideoMethods: ['hardware'] }])('refuses exact checks without hash generation before loading a renderer: %j', checks => {
  const dir = mkdtempSync(join(tmpdir(), 'swr-export-preflight-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ cases: [{}], methods: [{}], renderer: '/renderer-must-not-be-loaded.ts', ...checks }));
    try {
      execFileSync(process.execPath, [new URL('./export-comparison-runner.mjs', import.meta.url).pathname, '--config', file, '--check'], { stdio: 'pipe' });
      throw new Error('preflight unexpectedly passed');
    } catch (error) {
      expect(error.stderr?.toString()).toContain('Exact output checks require decodedHashChecks');
      expect(error.stderr?.toString()).not.toContain('ERR_MODULE_NOT_FOUND');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
