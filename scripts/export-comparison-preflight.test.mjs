import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function invoke(config) {
  const dir = mkdtempSync(join(tmpdir(), 'swr-export-preflight-'));
  try {
    const renderer = join(dir, 'renderer.mjs');
    const project = join(dir, 'project');
    mkdirSync(project);
    writeFileSync(renderer, 'export async function render() {}');
    writeFileSync(join(project, 'project.json'), '{}');
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({
      cases: [{ id: 'diagnostic', project, frames: 180, fps: 30, width: 1280, height: 720 }],
      methods: [
        { id: 'baseline', renderer, expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1', options: { preset: 'h265-hardware' } },
        { id: 'candidate', renderer, expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1', options: { preset: 'h265-hardware' } },
      ],
      renderer,
      qualityPolicy: { preset: 'h265-hardware', expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1' },
      decodedHashChecks: true,
      exactAudioRequired: true,
      guards: { rssMiB: 2048, trialSeconds: 180, swapGrowthMiB: 256 },
      ...config,
    }));
    try {
      return execFileSync(process.execPath, [new URL('./export-comparison-runner.mjs', import.meta.url).pathname, '--config', file, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { throw new Error(error.stderr?.toString() ?? error.message); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it.each([{ exactAudioRequired: true, decodedHashChecks: false }, { exactVideoMethods: ['candidate'], decodedHashChecks: false }])(
  'refuses exact checks without hash generation before loading a renderer: %j', checks => {
    expect(() => invoke(checks)).toThrow(/Exact output checks require decodedHashChecks/);
  },
);

it('preflights pinned method entrypoints, encoder, and shared quality policy without importing a renderer', () => {
  expect(JSON.parse(invoke({}))).toMatchObject({ status: 'PREFLIGHT_PASSED', methods: 2, cases: 1 });
});

it('refuses different quality presets across the pair during preflight', () => {
  expect(() => invoke({ methods: [
    { id: 'baseline', expectedEncoder: 'hevc_videotoolbox', options: { preset: 'h265-hardware' } },
    { id: 'candidate', expectedEncoder: 'hevc_videotoolbox', options: { preset: 'master' } },
  ] })).toThrow(/shared qualityPolicy.preset/);
});
