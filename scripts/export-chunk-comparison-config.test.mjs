import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: (_command, args) => {
  if (args[2] === 'rev-parse') return args[1].endsWith('baseline') ? '873e8b0'.padEnd(40, '0') + '\n' : '1234567'.padEnd(40, '0') + '\n';
  if (args[2] === 'ls-files') return 'packages/render/src/node.ts\n';
  return '';
} }));
import { buildConfig } from './export-chunk-comparison-config.mjs';

it('resolves the short baseline ref before comparison and fingerprints both renderers', () => {
  const root = mkdtempSync(join(tmpdir(), 'swr-chunk-config-'));
  try {
    for (const name of ['baseline', 'candidate']) {
      mkdirSync(join(root, name, 'packages/render/src'), { recursive: true });
      writeFileSync(join(root, name, 'packages/render/src/node.ts'), name);
    }
    const manifestFile = join(root, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify({ seed: 20261004, sources: {}, fixtures: ['diagnostic', 'real'].map(caseId => ({
      caseId, variant: 'chunk-stress', projectDir: join(root, caseId), projectSha256: 'project-hash',
      width: 1280, height: 720, fps: 30, frames: 180, semanticCounts: { captions: 10, transitions: 5 }, audio: { present: true },
    })) }));
    const config = buildConfig({ manifestFile, baselineWorktree: join(root, 'baseline'), candidateWorktree: join(root, 'candidate'), outFile: join(root, 'config.json') });
    expect(config.provenance.baseline.commit).toHaveLength(40);
    expect(config.fingerprints.filter(file => file.path.endsWith('/node.ts'))).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).methods.map(method => method.source.commit)).toEqual(config.methods.map(method => method.source.commit));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
