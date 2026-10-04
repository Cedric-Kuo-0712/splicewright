import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeConcurrentTrackProject, makeSequentialProject } from './export-memory-benchmark.mjs';

const fixture = '/path/to/splicewright/.codex-jobs/export-batch-memory-4g-20261004T123148Z/fixtures/real-five-minute/project.json';
const source = JSON.parse(readFileSync(fixture, 'utf8'));

it.each([10, 100, 200])('creates a 300-second %i-clip sequential case without graphics', (count) => {
  const project = makeSequentialProject(source, count);
  const video = project.tracks.find(track => track.kind === 'video');
  expect(project.meta.fps).toBe(30);
  expect(video.items).toHaveLength(count);
  expect(video.items[0].start).toBe(0);
  expect(video.items.at(-1).start + video.items.at(-1).duration).toBe(9000);
  expect(project.tracks).toHaveLength(1);
  expect(video.items.every(item => !item.transition)).toBe(true);
});

it('creates overlapping video tracks for the Remotion-only stress case', () => {
  const project = makeConcurrentTrackProject(source, 3);
  expect(project.tracks).toHaveLength(3);
  expect(project.tracks.every(track => track.kind === 'video')).toBe(true);
  expect(project.tracks[0].items[0].start).toBe(project.tracks[1].items[0].start);
  expect(project.tracks[0].items[0].duration).toBe(project.tracks[2].items[0].duration);
});
