import { expect, it } from 'vitest';
import { createProject } from '@splicewright/core';
import { makeConcurrentTrackProject, makeSequentialProject, validateMemoryFixture } from './export-memory-benchmark.mjs';

function fixtureProject() {
  const project = createProject({ title: 'synthetic-memory-fixture', fps: 30, width: 1920, height: 1080 });
  project.assets = {
    a: { id: 'a', kind: 'video', path: 'raw/a.mp4' },
    b: { id: 'b', kind: 'video', path: 'raw/b.mp4' },
  };
  project.tracks = [{ id: 'video_1', name: 'V1', kind: 'video', magnetic: true, items: [
    { id: 'source_clip_1', start: 0, duration: 900, assetId: 'a', sourceIn: 12, volume: 1 },
    { id: 'source_clip_2', start: 900, duration: 900, assetId: 'b', sourceIn: 40, volume: 1 },
  ] }];
  project.ids = { clip: 2, caption: 0 };
  return project;
}
const source = fixtureProject();
const manifest = {
  a: { kind: 'video', fingerprint: 'a1', duration: 51, width: 1920, height: 1080, fps: 30, audio: true },
  b: { kind: 'video', fingerprint: 'b1', duration: 81, width: 1920, height: 1080, fps: 30, audio: true },
};

it.each([10, 100, 200])('creates a 300-second %i-clip sequential case without graphics', (count) => {
  const project = makeSequentialProject(source, count);
  const video = project.tracks.find(track => track.kind === 'video');
  expect(project.meta.fps).toBe(30);
  expect(video.items).toHaveLength(count);
  expect(video.items[0].start).toBe(0);
  expect(video.items.at(-1).start + video.items.at(-1).duration).toBe(9000);
  expect(project.tracks).toHaveLength(1);
  expect(video.muted).toBe(true);
  expect(video.items.every(item => !item.transition)).toBe(true);
  expect(() => validateMemoryFixture(project, manifest, [0, 9000])).not.toThrow();
});

it('creates an overlapping 30-second Remotion-only stress case', () => {
  const project = makeConcurrentTrackProject(source, 3);
  expect(project.tracks).toHaveLength(3);
  expect(project.tracks.every(track => track.kind === 'video')).toBe(true);
  expect(project.tracks[0].items[0].start).toBe(project.tracks[1].items[0].start);
  expect(project.tracks[0].items[0].duration).toBe(900);
  expect(() => validateMemoryFixture(project, manifest, [0, 900], { layered: false })).not.toThrow();
});
