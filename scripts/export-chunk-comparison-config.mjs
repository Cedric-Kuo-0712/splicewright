#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE_COMMIT = '873e8b0';
const PRESET = 'h265-hardware';
const EXPECTED_ENCODER = 'hevc_videotoolbox';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function sourceIdentity(worktree) {
  const root = resolve(worktree);
  const commit = git(root, 'rev-parse', 'HEAD');
  const patch = git(root, 'diff', '--binary', 'HEAD', '--', 'packages/render/src');
  return {
    worktree: root,
    commit,
    renderPatchSha256: sha256(patch),
    dirtyRenderFiles: git(root, 'status', '--porcelain', '--', 'packages/render/src').split('\n').filter(Boolean),
    renderer: resolve(root, 'packages/render/src/node.ts'),
  };
}

function buildConfig({ manifestFile, baselineWorktree, candidateWorktree, outFile }) {
  const manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'));
  if (manifest.seed !== 20261004) throw new Error('Expected fixed fixture seed 20261004');
  const baseline = sourceIdentity(baselineWorktree), candidate = sourceIdentity(candidateWorktree);
  if (baseline.commit !== git(baseline.worktree, 'rev-parse', BASELINE_COMMIT)) throw new Error(`Baseline must be controlled 4 GiB commit ${BASELINE_COMMIT}; got ${baseline.commit}`);
  if (baseline.dirtyRenderFiles.length) throw new Error('Baseline renderer has uncommitted changes');
  if (!candidate.dirtyRenderFiles.length && candidate.commit === baseline.commit) throw new Error('Candidate renderer must identify a distinct implementation');
  const fixtures = manifest.fixtures.filter(fixture => fixture.variant === 'chunk-stress');
  if (fixtures.length !== 2 || !fixtures.some(f => f.caseId === 'diagnostic') || !fixtures.some(f => f.caseId === 'real'))
    throw new Error('Manifest must contain diagnostic and real chunk-stress fixtures');
  const cases = fixtures.map(fixture => ({
    id: fixture.caseId,
    project: fixture.projectDir,
    projectSha256: fixture.projectSha256,
    expected: { width: fixture.width, height: fixture.height, fps: fixture.fps, frames: fixture.frames, overlays: fixture.semanticCounts.captions, transitions: fixture.semanticCounts.transitions },
    width: fixture.width,
    height: fixture.height,
    fps: fixture.fps,
    frames: fixture.frames,
    audio: fixture.audio.present,
    range: [0, fixture.frames],
  }));
  const fingerprints = [
    ...Object.values(manifest.sources).map(source => ({ path: source.path, sha256: source.sha256 })),
    ...fixtures.map(fixture => ({ path: resolve(fixture.projectDir, 'project.json'), sha256: fixture.projectSha256 })),
    ...[baseline, candidate].flatMap(source => git(source.worktree, 'ls-files', 'packages/render/src').split('\n').filter(Boolean)
      .map(file => ({ path: resolve(source.worktree, file), sha256: sha256(readFileSync(resolve(source.worktree, file))) }))),
  ];
  const config = {
    schemaVersion: 1,
    seed: manifest.seed,
    createdAt: new Date().toISOString(),
    repo: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    renderer: candidate.renderer,
    provenance: { fixtureManifest: resolve(manifestFile), fixtureManifestSha256: sha256(readFileSync(resolve(manifestFile))), baseline, candidate },
    qualityPolicy: { preset: PRESET, codec: 'h265', expectedEncoder: EXPECTED_ENCODER, expectedCodec: 'hevc', expectedTag: 'hvc1', comparison: 'same preset/encoder; no bitrate or quality changes' },
    cases,
    methods: [
      { id: 'baseline-fullpng', renderer: baseline.renderer, source: baseline, expectedEncoder: EXPECTED_ENCODER, expectedCodec: 'hevc', expectedTag: 'hvc1', options: { pipeline: 'layered', preset: PRESET, resources: { concurrency: 2, filterThreads: 2, encoderThreads: 4, graphicsScheduling: 'serial' } } },
      { id: 'candidate-chunked', renderer: candidate.renderer, source: candidate, expectedEncoder: EXPECTED_ENCODER, expectedCodec: 'hevc', expectedTag: 'hvc1', options: { pipeline: 'layered', preset: PRESET, resources: { concurrency: 2, filterThreads: 2, encoderThreads: 4, graphicsScheduling: 'serial' } } },
    ],
    fingerprints,
    validationBaseline: 'baseline-fullpng',
    decodedHashChecks: true,
    exactAudioRequired: true,
    guards: { rssMiB: 2048, trialSeconds: 180, swapGrowthMiB: 256 },
    order: 'methods alternate per case; exactly one trial per case/method',
    limitations: ['Screening result only: one trial each, no universal performance claim.', 'The hardware encoder output is compared by full decoded hashes and diagnostics; encoded file hashes are not a video equivalence test.'],
  };
  writeFileSync(resolve(outFile), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  return config;
}

function parse(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--manifest', '--baseline-worktree', '--candidate-worktree', '--out'].includes(flag) || !args[i + 1]) throw new Error('Usage: --manifest <fixture-manifest.json> --baseline-worktree <path> --candidate-worktree <path> --out <new-config.json>');
    values[flag] = args[++i];
  }
  return { manifestFile: values['--manifest'], baselineWorktree: values['--baseline-worktree'], candidateWorktree: values['--candidate-worktree'], outFile: values['--out'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parse(process.argv.slice(2));
    const config = buildConfig(options);
    console.log(JSON.stringify({ status: 'CONFIG_CREATED', out: resolve(options.outFile), seed: config.seed, cases: config.cases.length, methods: config.methods.map(({ id, source }) => ({ id, commit: source.commit, renderPatchSha256: source.renderPatchSha256 })) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

export { buildConfig };
