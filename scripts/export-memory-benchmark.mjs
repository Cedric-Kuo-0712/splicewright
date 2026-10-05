import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '@splicewright/core';
import { planLayeredExport } from '../packages/render/src/layered.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootRepo = resolve(repo, '../..');
const sourceFixture = resolve(rootRepo, '.codex-jobs/export-batch-memory-4g-20261004T123148Z/fixtures/real-five-minute');
const priorConfig = resolve(rootRepo, '.codex-jobs/export-batch-memory-4g-20261004T123148Z/comparison.json');
const priorSuccessfulClipRun = resolve(repo, '.codex-jobs/export-memory-profile-af5cc10-retry-launchd/clip-count/result.json');
const BASELINE = '57981f611edc7066b8b851d0dae8162654f1d26f';

export function makeSequentialProject(source, count) {
  if (![10, 100, 200].includes(count)) throw new Error('clip count must be 10, 100, or 200');
  const project = structuredClone(source);
  const sourceItems = source.tracks.find(track => track.kind === 'video')?.items;
  if (!sourceItems?.length) throw new Error('fixture requires source video clips');
  const totalFrames = project.meta.fps * 300;
  const clipFrames = totalFrames / count;
  if (!Number.isInteger(clipFrames)) throw new Error('clip count must divide the 5-minute frame count');
  const clips = Array.from({ length: count }, (_, index) => {
    const sourceItem = sourceItems[index % sourceItems.length];
    return { id: `clip_${index + 1}`, start: index * clipFrames, duration: clipFrames, assetId: sourceItem.assetId, sourceIn: sourceItem.sourceIn, volume: sourceItem.volume ?? 1 };
  });
  project.meta.title = `export-memory-sequential-${count}`;
  project.tracks = project.tracks.filter(track => track.kind === 'video').slice(0, 1).map(track => ({ ...track, id: 'video_1', muted: true, items: clips }));
  project.ids = { ...project.ids, clip: count, caption: 0 };
  return project;
}

export function makeConcurrentTrackProject(source, count = 3) {
  if (!Number.isInteger(count) || count < 2 || count > 4) throw new Error('concurrent video tracks must be between 2 and 4');
  const video = source.tracks.find(track => track.kind === 'video');
  if (!video?.items?.length) throw new Error('fixture requires source video clips');
  const project = structuredClone(source);
  const duration = project.meta.fps * 30;
  const tracks = Array.from({ length: count }, (_, trackIndex) => ({
    id: `video_${trackIndex + 1}`, name: `V${trackIndex + 1}`, kind: 'video', magnetic: false,
    items: [{ id: `v${trackIndex + 1}_clip_1`, start: 0, duration, assetId: video.items[trackIndex % video.items.length].assetId, sourceIn: video.items[trackIndex % video.items.length].sourceIn, volume: trackIndex === 0 ? 1 : 0.15 }],
  }));
  project.meta.title = `export-memory-concurrent-${count}-track-remotion`;
  project.tracks = tracks;
  project.ids = { ...project.ids, clip: count, caption: 0 };
  return project;
}

export function validateMemoryFixture(project, assetManifest, range = [0, project.meta.fps * 300], { layered = true } = {}) {
  const probes = {}, assetDurations = {};
  for (const asset of Object.values(project.assets)) {
    const cached = assetManifest[asset.id];
    if (!cached || cached.kind !== 'video' || !Number.isFinite(cached.duration)) throw new Error(`fixture requires a valid video probe cache for ${asset.id}`);
    assetDurations[asset.id] = cached.duration;
    probes[asset.id] = { ...cached, path: asset.path, fingerprint: cached.fingerprint };
  }
  const errors = validate(project, undefined, { assetDurations });
  if (errors.length) throw new Error(`invalid memory fixture: ${errors.join('; ')}`);
  if (layered) planLayeredExport(project, probes, range[0], range[1]);
  return { probes, assetDurations };
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}
const sha256Text = value => createHash('sha256').update(value).digest('hex');
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  }).sort();
}
function generatedEntryHash(rendererRoot) {
  const lines = [
    'import { registerRoot } from "remotion";',
    `import { makeRoot } from ${JSON.stringify(join(rendererRoot, 'Root.tsx'))};`,
    'const config = {};',
    'registerRoot(makeRoot(config));',
  ];
  return sha256Text(lines.join('\n'));
}
function generatedEntryText(rendererRoot) {
  return [
    'import { registerRoot } from "remotion";',
    `import { makeRoot } from ${JSON.stringify(join(rendererRoot, 'Root.tsx'))};`,
    'const config = {};',
    'registerRoot(makeRoot(config));',
  ].join('\n');
}
function writeFixture(sourceProject, sourceDir, targetDir, project) {
  mkdirSync(join(targetDir, '.splicewright'), { recursive: true });
  mkdirSync(join(targetDir, 'raw'), { recursive: true });
  writeFileSync(join(targetDir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  for (const leaf of ['entry.tsx', 'assets.json']) copyFileSync(join(sourceDir, '.splicewright', leaf), join(targetDir, '.splicewright', leaf));
  writeFileSync(join(targetDir, '.splicewright/entry.tsx'), generatedEntryText(resolve(repo, 'packages/render/src')));
  for (const asset of Object.values(project.assets)) {
    const from = resolve(sourceDir, asset.path), to = resolve(targetDir, asset.path);
    mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to)) symlinkSync(from, to);
  }
  const manifest = JSON.parse(readFileSync(join(targetDir, '.splicewright/assets.json'), 'utf8'));
  const frames = Math.max(...project.tracks.flatMap(track => track.items.map(item => item.start + item.duration)));
  const layered = project.tracks.filter(track => track.kind === 'video' && !track.hidden).length === 1;
  validateMemoryFixture(project, manifest, [0, frames], { layered });
  const audio = project.tracks.some(track => track.kind === 'video' && !track.muted && track.items.some(item => (manifest[item.assetId]?.audio ?? false) && (item.volume ?? 1) > 0));
  return { id: project.meta.title.replace(/^export-memory-/, ''), project: targetDir, width: project.meta.width, height: project.meta.height, fps: project.meta.fps, frames, audio, range: [0, frames], fixtureFiles: ['project.json', '.splicewright/assets.json', '.splicewright/entry.tsx'].map(path => join(targetDir, path)) };
}

export function prepareBenchmark(outDir, { activeWindowOnly = false } = {}) {
  const base = resolve(outDir);
  if (existsSync(base)) throw new Error(`Refusing to overwrite benchmark directory: ${base}`);
  const sourceProject = JSON.parse(readFileSync(join(sourceFixture, 'project.json'), 'utf8'));
  const sourceManifest = JSON.parse(readFileSync(join(sourceFixture, '.splicewright/assets.json'), 'utf8'));
  validateMemoryFixture(sourceProject, sourceManifest, [0, 9000]);
  const prior = JSON.parse(readFileSync(priorConfig, 'utf8'));
  const currentHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const baselineRenderer = resolve(rootRepo, 'packages/render/src/node.ts');
  const candidateRenderer = resolve(repo, 'packages/render/src/node.ts');
  const baselineHead = execFileSync('git', ['-C', rootRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (baselineHead !== BASELINE) throw new Error(`baseline checkout moved: expected ${BASELINE}, found ${baselineHead}`);
  const sourcePathspec = ['packages/render', 'packages/core', 'packages/ingest', 'scripts/export-comparison-runner.mjs', 'scripts/export-memory-benchmark.mjs', 'scripts/export-memory-validate.mjs', 'scripts/export-resource-processes.mjs', 'scripts/export-output-encoder.mjs'];
  for (const [label, cwd] of [['baseline', rootRepo], ['candidate', repo]]) {
    const dirty = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--', ...sourcePathspec], { encoding: 'utf8' }).trim();
    if (dirty) throw new Error(`${label} source tree is dirty: ${dirty}`);
  }
  const stableRendererSources = [...new Set([
    ...sourceFiles(resolve(rootRepo, 'packages/render/src')),
    ...sourceFiles(resolve(repo, 'packages/render/src')),
    ...['core', 'ingest'].flatMap(name => sourceFiles(resolve(rootRepo, `packages/${name}/src`))),
    ...['core', 'ingest'].flatMap(name => sourceFiles(resolve(repo, `packages/${name}/src`))),
    ...['export-comparison-runner.mjs', 'export-resource-processes.mjs', 'export-output-encoder.mjs', 'export-memory-benchmark.mjs', 'export-memory-validate.mjs'].map(name => resolve(repo, 'scripts', name)),
    ...['render', 'core', 'ingest'].flatMap(name => [resolve(rootRepo, `packages/${name}/package.json`), resolve(repo, `packages/${name}/package.json`)]),
    resolve(rootRepo, 'package-lock.json'),
    resolve(repo, 'package-lock.json'),
  ])].sort();
  const common = {
    schemaVersion: 1, repo: rootRepo, renderer: candidateRenderer, seed: 20261004,
    guards: { rssMiB: 4096, swapGrowthMiB: 256, trialSeconds: 900, samplingMs: 1000 },
    decodedHashChecks: { timeoutMs: 600000 },
    provenance: { baseline: BASELINE, candidate: currentHead, fixtureProjectSha256: sha256(join(sourceFixture, 'project.json')), sourceAssets: prior.provenance.fixture.sources.map(item => ({ path: item.path, sha256: item.sha256 })) },
  };
  const options = { pipeline: 'layered', preset: 'h265-hardware', resources: { concurrency: 2, filterThreads: 2, encoderThreads: 4, graphicsScheduling: 'grouped' } };
  const method = (id, renderer, extra = {}) => ({ id, renderer, source: { commit: id === 'main-baseline' ? BASELINE : currentHead, renderer }, expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1', options: structuredClone(options), ...extra });
  const baselineOptions = structuredClone(options);
  const writeConfig = (name, cases, methods, fixtureProjects = [], extraProvenance = {}) => {
    const runDir = join(base, name.replace(/\.json$/, ''));
    mkdirSync(runDir, { recursive: true });
    const codeFiles = stableRendererSources;
    const sourceInputs = prior.fingerprints.filter(item => item.path.startsWith('/path/to/test-project/raw/'));
    const fingerprints = [...new Set(codeFiles)].map(path => ({ path, sha256: sha256(path) }));
    fingerprints.push(...sourceInputs, ...fixtureProjects.filter(path => !path.endsWith('entry.tsx')).map(path => ({ path, sha256: sha256(path) })));
    const entryInputs = cases.map(testCase => {
      const entry = join(testCase.project, '.splicewright/entry.tsx');
      return { path: entry, templateSha256: sha256(entry), emittedSha256ByRenderer: { [baselineRenderer]: generatedEntryHash(dirname(baselineRenderer)), [candidateRenderer]: generatedEntryHash(dirname(candidateRenderer)) }, overwrittenByBundle: true };
    });
    const fixtureInputs = cases.flatMap(testCase => [join(testCase.project, 'project.json'), join(testCase.project, '.splicewright/assets.json')]);
    const config = { ...common, fingerprints, cases, methods, provenance: { ...common.provenance, stableRendererSourceCount: stableRendererSources.length, fixtureInputs: fixtureInputs.map(path => ({ path, sha256: sha256(path) })), generatedEntries: entryInputs, ...extraProvenance }, ...(methods.some(method => method.id === 'main-baseline') ? { validationBaseline: 'main-baseline', qualityPolicy: { preset: 'h265-hardware', expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1' }, qualityOptions: baselineOptions } : {}) };
    writeFileSync(join(runDir, 'comparison.json'), `${JSON.stringify(config, null, 2)}\n`);
    return join(runDir, 'comparison.json');
  };
  mkdirSync(base, { recursive: true });
  const launches = [];
  if (!activeWindowOnly) {
    const sourceCase = { ...writeFixture(sourceProject, sourceFixture, join(base, 'fixtures', 'real-five-minute'), sourceProject), id: 'real-five-minute', range: [0, 9000] };
    launches.push(writeConfig('real-five-minute', [sourceCase], [
      method('main-baseline', baselineRenderer, { options: baselineOptions }),
      method('candidate-current', candidateRenderer),
      method('candidate-cap64', candidateRenderer, { experimentalFilterBufferedFrames: 64 }),
      method('candidate-cap128', candidateRenderer, { experimentalFilterBufferedFrames: 128 }),
    ], [join(sourceFixture, 'project.json'), join(sourceFixture, '.splicewright/assets.json'), ...sourceCase.fixtureFiles]));
  }
  const countCases = [10, 100, 200].map(count => {
    const fixturePath = join(base, 'fixtures', `sequential-${count}`);
    const testCase = writeFixture(sourceProject, sourceFixture, fixturePath, makeSequentialProject(sourceProject, count));
    return { ...testCase, id: `sequential-${count}` };
  });
  let clipCountConfig;
  if (activeWindowOnly) {
    const priorRun = JSON.parse(readFileSync(priorSuccessfulClipRun, 'utf8'));
    const priorTrial = priorRun.trials.find(trial => trial.name === 'sequential-10-candidate-current' && trial.result?.status === 'DONE' && trial.result.fullDecode === true);
    if (!priorTrial || priorRun.config.provenance.candidate !== 'af5cc1088bc88085cc0edbaa0a9fa191152803cb') throw new Error('Missing preserved, full-decoded sequential-10 reference from the pinned prior candidate');
    const referenceOutput = priorTrial.result.output;
    const referenceSha256 = execFileSync('shasum', ['-a', '256', referenceOutput], { encoding: 'utf8' }).split(/\s+/)[0];
    clipCountConfig = writeConfig('active-window-clip-count', countCases,
      [method('candidate-active-window', candidateRenderer, { experimentalActiveWindow: true })], countCases.flatMap(testCase => testCase.fixtureFiles),
      { priorSuccessful10: { output: referenceOutput, fileSha256: referenceSha256, sourceCommit: priorRun.config.provenance.candidate, renderMs: priorTrial.result.renderMs, peakRssMiB: priorTrial.peakRssMiB, decodedFull: true } });
  } else {
    clipCountConfig = writeConfig('clip-count', countCases, [method('candidate-current', candidateRenderer)], countCases.flatMap(testCase => testCase.fixtureFiles));
  }
  launches.push(clipCountConfig);
  if (activeWindowOnly) return { directory: base, head: currentHead, baseline: BASELINE, priorSequential10: JSON.parse(readFileSync(clipCountConfig, 'utf8')).provenance.priorSuccessful10, launches: launches.map(config => `nice -n 10 node scripts/export-comparison-runner.mjs --config ${config}`), preparedOnly: true };
  const remotionDir = join(base, 'fixtures', 'concurrent-remotion-3-track');
  const remotionCase = writeFixture(sourceProject, sourceFixture, remotionDir, makeConcurrentTrackProject(sourceProject, 3));
  const concurrentFingerprints = [...stableRendererSources, join(remotionDir, 'project.json'), join(remotionDir, '.splicewright/assets.json'), ...prior.fingerprints.filter(item => item.path.startsWith('/path/to/test-project/raw/')).map(item => item.path)].map(path => ({ path, sha256: sha256(path) }));
  const concurrentDir = join(base, 'concurrent-remotion');
  mkdirSync(concurrentDir, { recursive: true });
  const concurrentConfig = join(concurrentDir, 'comparison.json');
  writeFileSync(concurrentConfig, `${JSON.stringify({ ...common, renderer: candidateRenderer, fingerprints: concurrentFingerprints.filter(item => item.path !== join(remotionDir, '.splicewright/entry.tsx')), cases: [{ ...remotionCase, id: 'concurrent-remotion-3-track' }], methods: [{ id: 'remotion-default', renderer: candidateRenderer, source: { commit: currentHead, renderer: candidateRenderer }, expectedEncoder: 'hevc_videotoolbox', expectedCodec: 'hevc', expectedTag: 'hvc1', options: { preset: 'h265-hardware' } }], provenance: { ...common.provenance, stableRendererSourceCount: stableRendererSources.length, fixtureInputs: [join(remotionCase.project, 'project.json'), join(remotionCase.project, '.splicewright/assets.json')].map(path => ({ path, sha256: sha256(path) })), generatedEntries: [{ path: join(remotionCase.project, '.splicewright/entry.tsx'), templateSha256: sha256(join(remotionCase.project, '.splicewright/entry.tsx')), emittedSha256ByRenderer: { [candidateRenderer]: generatedEntryHash(dirname(candidateRenderer)) }, overwrittenByBundle: true }], clipCountAudioPolicy: 'Sequential clip-count cases mute their only video track, so native export maps no audio inputs.' } }, null, 2)}\n`);
  launches.push(concurrentConfig);
  return { directory: base, head: currentHead, baseline: BASELINE, launches: launches.map(config => `nice -n 10 node scripts/export-comparison-runner.mjs --config ${config}`), preparedOnly: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const activeWindowOnly = process.argv.includes('--prepare-active-window');
  const index = process.argv.indexOf(activeWindowOnly ? '--prepare-active-window' : '--prepare');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/export-memory-benchmark.mjs (--prepare | --prepare-active-window) <new-output-directory>');
  console.log(JSON.stringify(prepareBenchmark(process.argv[index + 1], { activeWindowOnly }), null, 2));
}
