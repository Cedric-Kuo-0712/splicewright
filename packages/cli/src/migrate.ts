import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apply, createProject, itemSpan, validate } from "@splicewright/core";
import type { AudioItem, CaptionItem, Project, Track, VideoItem } from "@splicewright/core";

// Spec §11: one-off importer for the video-cut Kaohsiung vlog. Project-specific by design: it
// reproduces what my-video/src/Vlog.tsx and scripts/apply_subtitles_correction.py do today.

interface Clip {
  clip_id?: string; source: string; source_in: number; source_out: number; role?: string; captions?: boolean;
  live_audio_volume?: number; rotation?: number; fit?: "contain" | "cover"; component?: string; description?: string;
}
interface Music {
  id: string; track: string; timeline_start: number; timeline_end: number; source_offset?: number; base_volume: number;
  duck_under_speech?: boolean; duck_level?: number; fade_in?: number; fade_out?: number;
}
interface Plan {
  project: { title: string; fps: number; width: number; height: number };
  music_tracks?: Music[];
  sections: { id: string; clips: Clip[] }[];
  polaroids?: Record<string, Record<string, unknown> & { imageSrc: string }>;
  custom_video_tracks?: unknown[];
  custom_audio_tracks?: unknown[];
}
type Segment = { start: number; end: number; text: string };

// my-video's staticFile() root; its raw/ and work/ are symlinks back to the repo root.
const PUBLIC = "my-video/public";
// guess: video-cut declared duck_under_speech but never implemented it, so there is no level to port.
const DUCK_LEVEL = 0.3;
// Render order of the overlay tracks, matching the JSX order inside Vlog.tsx's clip sequence.
const OVERLAYS = ["FilmStrip", "LocationCard", "NowPlayingCard", "Polaroid", "IntroTitleCard"];
// Overlay component → [my-video/src file, export]; copied into components/ (spec §11).
const COMPONENTS: Record<string, [string, string]> = {
  FilmStrip: ["FilmStripDemo", "FilmStripDemoComposition"],
  LocationCard: ["LocationCard", "LocationCard"],
  NowPlayingCard: ["NowPlayingCard", "NowPlayingCard"],
  Polaroid: ["PolaroidOverlay", "PolaroidOverlay"],
  IntroTitleCard: ["IntroTitleCard", "IntroTitleCard"],
};
const IGNORED_CLIP_FIELDS = ["shoutouts", "enhanced_audio"]; // unused by Vlog.tsx

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

/** Evaluates the `const NAME = {...};` object literal from Vlog.tsx (trusted local source). */
function readConst(src: string, name: string): Record<string, any> {
  const m = new RegExp(`const ${name}\\b[^=]*=\\s*(\\{[\\s\\S]*?\\n\\});`).exec(src);
  if (!m) throw new Error(`${name} not found in Vlog.tsx`);
  return new Function(`return (${m[1]});`)();
}

export function migrateVideoCut(src: string, outDir: string, opts: { force?: boolean } = {}) {
  if (!opts.force && existsSync(join(outDir, "project.json")))
    return { error: { code: "exists", message: `${outDir}/project.json exists; pass --force to overwrite` } };
  const plan: Plan = readJson(join(src, "work/edit-plan.json"));
  if (plan.custom_video_tracks?.length || plan.custom_audio_tracks?.length)
    return { error: { code: "unsupported", message: "custom_video_tracks / custom_audio_tracks are not migrated yet" } };
  const vlog = readFileSync(join(src, "my-video/src/Vlog.tsx"), "utf8");
  const titles = readConst(vlog, "SECTION_TITLES");
  const songs = readConst(vlog, "CONCERT_SONGS");
  const polaroids = plan.polaroids ?? readConst(vlog, "POLAROID_MOMENTS");
  const fps = plan.project.fps;
  const frames = (sec: number) => Math.round(sec * fps);
  const ignored = new Set<string>();

  // Assets first: importAsset derives the ids, and each apply() returns a fresh clone.
  let p: Project = createProject({ ...plan.project, background: "#000000" });
  const paths = [
    ...plan.sections.flatMap((s) => s.clips.filter((c) => !c.component).map((c) => c.source)),
    ...(plan.music_tracks ?? []).map((m) => `${PUBLIC}/${m.track}`),
  ];
  for (const path of new Set(paths)) {
    const r = apply(p, "importAsset", { path });
    if ("error" in r) return r;
    p = r.project;
  }
  const assetOf = (path: string) => Object.values(p.assets).find((a) => a.path === path)!.id;

  const counters: Record<string, number> = { i: 0, c: 0, m: 0, t: p.tracks.length };
  const id = (prefix: string) => `${prefix}_${(++counters[prefix]).toString(36)}`;
  const [v1, a1, c1] = p.tracks;
  const overlayTracks = new Map<string, Track>();
  const overlay = (component: string, start: number, duration: number, props: Record<string, unknown>, anchor?: VideoItem) => {
    if (!overlayTracks.has(component)) overlayTracks.set(component, { id: id("t"), name: component, kind: "overlay", items: [] });
    // Anchored to the clip's source range, so it follows that clip through later edits.
    const a = anchor && { anchor: { itemId: anchor.id, sourceStart: anchor.sourceIn, sourceEnd: anchor.sourceIn + duration / fps } };
    overlayTracks.get(component)!.items.push({ id: id("i"), start, duration, component, props, ...a } as never);
  };

  // ---- V1: sections play back to back ----
  const placed: { item: VideoItem; clipId?: string; captions: boolean }[] = [];
  let cursor = 0;
  for (const sec of plan.sections) {
    const secStart = cursor;
    sec.clips.forEach((clip, idx) => {
      const duration = Math.max(1, frames(clip.source_out - clip.source_in));
      const start = cursor;
      cursor += duration;
      for (const k of IGNORED_CLIP_FIELDS) if (k in clip) ignored.add(`clip.${k}`);
      if (clip.component) return overlay(clip.component, start, duration, {});

      const item: VideoItem = {
        id: id("i"), start, duration, assetId: assetOf(clip.source), sourceIn: clip.source_in,
        ...(clip.clip_id && { label: clip.clip_id }),
        ...(clip.description && { note: clip.description }),
        ...(clip.role && { role: clip.role }),
        ...(clip.live_audio_volume !== undefined && { volume: clip.live_audio_volume }),
        ...(clip.fit && { fit: clip.fit }),
        ...(clip.rotation && { transform: { rotation: clip.rotation } }),
      };
      (v1.items as VideoItem[]).push(item);
      placed.push({ item, clipId: clip.clip_id, captions: clip.captions === true });

      // Hardcoded overlays from Vlog.tsx, each spanning its clip as the JSX did.
      const loc = titles[sec.id];
      if (loc && (sec.id === "sec_02_day1_arrival_and_arcade" ? idx === 1 : idx === 0)) overlay("LocationCard", start, duration, loc, item);
      const song = sec.id === "sec_04_day1_itzy_concert" && clip.clip_id ? songs[clip.clip_id] : undefined;
      if (song) overlay("NowPlayingCard", start, duration, { ...song, artist: "ITZY" }, item);
      const pol = clip.clip_id ? (polaroids[`${sec.id}_${clip.clip_id}`] ?? polaroids[clip.clip_id]) : undefined;
      if (pol) overlay("Polaroid", start, duration, { ...pol, imageSrc: `${PUBLIC}/${pol.imageSrc}` }, item);
      if (sec.id === "sec_01_hook_and_intro" && clip.clip_id === "clip_0009") overlay("IntroTitleCard", start, duration, {}, item);
    });
    (p.markers ??= []).push({ id: id("m"), label: sec.id, start: secStart, duration: cursor - secStart });
  }
  if (plan.sections.some((s) => "purpose" in s)) ignored.add("section.purpose");

  // ---- A1 (+A2… if music overlaps) ----
  const audioTracks = [a1];
  for (const m of plan.music_tracks ?? []) {
    const item: AudioItem = {
      id: id("i"), start: frames(m.timeline_start), duration: frames(m.timeline_end - m.timeline_start),
      assetId: assetOf(`${PUBLIC}/${m.track}`), sourceIn: m.source_offset ?? 0, volume: m.base_volume, label: m.id,
      ...(m.fade_in && { fadeIn: frames(m.fade_in) }),
      ...(m.fade_out && { fadeOut: frames(m.fade_out) }),
      ...(m.duck_under_speech && { duck: { under: [v1.id], level: m.duck_level ?? DUCK_LEVEL } }),
    };
    let t = audioTracks.find((t) => t.items.every((i) => i.start + i.duration <= item.start || i.start >= item.start + item.duration));
    if (!t) audioTracks.push((t = { id: id("t"), name: `A${audioTracks.length + 1}`, kind: "audio", items: [] }));
    (t.items as AudioItem[]).push(item);
  }

  // ---- C1: anchored captions ----
  const captionReport = migrateCaptions(src, p, c1, placed, frames, id);

  p.tracks = [v1, ...OVERLAYS.flatMap((c) => overlayTracks.get(c) ?? []), ...[...overlayTracks.keys()].filter((c) => !OVERLAYS.includes(c)).map((c) => overlayTracks.get(c)!), ...audioTracks, c1];
  p.revision = 0;

  // ---- ingest caches from video-cut's work/ ----
  const assetDurations: Record<string, number> = {};
  const transcripts: Record<string, { segments: Segment[] }> = {};
  for (const c of readJson(join(src, "work/media-index.json")).clips as { id: string; source: string; duration: number }[]) {
    const a = Object.values(p.assets).find((x) => x.path === c.source);
    if (!a) continue;
    assetDurations[a.id] = c.duration;
    const tf = join(src, "work/transcripts", `${c.id}.json`);
    if (existsSync(tf)) transcripts[a.id] = { segments: readJson(tf).segments };
  }

  const errs = validate(p, undefined, { assetDurations });
  if (errs.length) return { error: { code: "invalid", message: errs.join("; ") } };

  mkdirSync(join(outDir, ".splicewright", "transcripts"), { recursive: true });
  writeFileSync(join(outDir, "project.json"), JSON.stringify(p, null, 2) + "\n");
  writeFileSync(join(outDir, ".splicewright", "assets.json"), JSON.stringify(Object.fromEntries(Object.entries(assetDurations).map(([k, d]) => [k, { duration: d }])), null, 2) + "\n");
  for (const [a, t] of Object.entries(transcripts)) writeFileSync(join(outDir, ".splicewright", "transcripts", `${a}.json`), JSON.stringify(t) + "\n");
  writeComponents(src, outDir);

  return {
    out: join(outDir, "project.json"),
    durationFrames: cursor,
    videoItems: placed.length,
    overlays: Object.fromEntries([...overlayTracks].map(([c, t]) => [c, t.items.length])),
    audioItems: audioTracks.reduce((n, t) => n + t.items.length, 0),
    markers: p.markers!.length,
    ignoredFields: [...ignored],
    guesses: plan.music_tracks?.some((m) => m.duck_under_speech && m.duck_level === undefined) ? [`duck level ${DUCK_LEVEL} (never implemented in video-cut)`] : [],
    captions: captionReport,
  };
}

/** Copies the vlog components into components/ and registers them in splicewright.config.ts. */
function writeComponents(src: string, outDir: string) {
  mkdirSync(join(outDir, "components"), { recursive: true });
  for (const [file] of Object.values(COMPONENTS)) {
    let code = readFileSync(join(src, "my-video/src", `${file}.tsx`), "utf8");
    if (file === "FilmStripDemo") {
      // Its frames are relative to my-video/public; the project folder is the static root now.
      const from = "staticFile(item.src)";
      if (!code.includes(from)) throw new Error(`FilmStripDemo.tsx no longer contains ${from}`);
      code = code.replace(from, `staticFile(\`${PUBLIC}/\${item.src}\`)`);
    }
    writeFileSync(join(outDir, "components", `${file}.tsx`), code);
  }
  const entries = Object.entries(COMPONENTS);
  writeFileSync(
    join(outDir, "splicewright.config.ts"),
    [
      `import { defineConfig } from "splicewright";`,
      ...entries.map(([, [file, name]]) => `import { ${name} } from "./components/${file}";`),
      ``,
      `export default defineConfig({`,
      `  components: {`,
      ...entries.map(([c, [, name]]) => `    ${c === name ? c : `${c}: ${name}`},`),
      `  },`,
      `});`,
      ``,
    ].join("\n"),
  );
}

/**
 * Source times come from matching the correction text against the clip transcript, exactly as
 * apply_subtitles_correction.py does. Each caption anchors to the captioned occurrence of its clip
 * nearest the timeline position recorded in subtitles_correction.json; the result is then diffed
 * against my-video/src/captions.json (what the current pipeline renders).
 */
function migrateCaptions(
  src: string, p: Project, c1: Track, placed: { item: VideoItem; clipId?: string; captions: boolean }[],
  frames: (s: number) => number, id: (prefix: string) => string,
) {
  const entries: { id: number; clip_id: string; timeline_start: number; text: string }[] = readJson(join(src, "work/subtitles_correction.json"));
  const userText = new Map<number, string>();
  const txt = join(src, "work/subtitles_correction.txt");
  if (existsSync(txt))
    for (const line of readFileSync(txt, "utf8").split("\n")) {
      const m = /^(\d+)\s+\[(\d{2}:\d{2}\.\d{2})\s*-\s*(\d{2}:\d{2}\.\d{2})\]\s*\(([^)]+)\):\s*(.*)$/.exec(line.trim());
      if (m) userText.set(Number(m[1]), m[5].trim());
    }
  const segsOf = (clipId: string): Segment[] => readJson(join(src, "work/transcripts", `${clipId}.json`)).segments ?? [];

  const unanchored: number[] = [];
  for (const e of entries) {
    const segs = segsOf(e.clip_id);
    const t = e.text.trim();
    const seg = segs.find((s) => s.text.trim() === t) ?? segs.find((s) => t.includes(s.text.trim()) || s.text.trim().includes(t));
    let [ss, se] = seg ? [seg.start, seg.end] : [0, 0];
    if (e.id === 1) [ss, se] = [0.5, 2.8]; // hand fix carried over from apply_subtitles_correction.py

    const target = placed
      .filter(({ item, clipId, captions }) => captions && clipId === e.clip_id && Math.max(item.sourceIn, ss) < Math.min(item.sourceIn + item.duration / p.meta.fps, se))
      .sort((a, b) => Math.abs(a.item.start - frames(e.timeline_start)) - Math.abs(b.item.start - frames(e.timeline_start)))[0];
    if (!target) {
      unanchored.push(e.id);
      continue;
    }
    const text = userText.get(e.id) ?? t;
    const hidden = !text || text.startsWith("----");
    const cap: CaptionItem = {
      id: id("c"), start: 0, duration: 1, mode: "anchored", itemId: target.item.id, sourceStart: ss, sourceEnd: se,
      text: hidden ? "" : text, ...(hidden && { note: `hidden in video-cut (${text || "empty"}); original: ${t}` }),
    };
    Object.assign(cap, itemSpan(p, cap) ?? {});
    (c1.items as CaptionItem[]).push(cap);
  }
  c1.items.sort((a, b) => a.start - b.start);

  // Diff against what the current pipeline renders.
  const expected: { start_frame: number; end_frame: number; text: string }[] = readJson(join(src, "my-video/src/captions.json"));
  const actual = (c1.items as CaptionItem[]).filter((c) => c.text && itemSpan(p, c)).map((c) => ({ id: c.id, start: c.start, end: c.start + c.duration, text: c.text }));
  const used = new Set<string>();
  let exact = 0;
  const shifted: string[] = [];
  const missing: string[] = [];
  for (const x of expected) {
    const match = actual.filter((a) => a.text === x.text && !used.has(a.id)).sort((a, b) => Math.abs(a.start - x.start_frame) - Math.abs(b.start - x.start_frame))[0];
    if (!match) {
      missing.push(`[${x.start_frame}-${x.end_frame}] ${x.text}`);
      continue;
    }
    used.add(match.id);
    if (match.start === x.start_frame && match.end === x.end_frame) exact++;
    else shifted.push(`${match.id} "${x.text}": expected ${x.start_frame}-${x.end_frame}, got ${match.start}-${match.end}`);
  }
  return {
    entries: entries.length,
    anchored: c1.items.length,
    hidden: (c1.items as CaptionItem[]).filter((c) => !c.text).length,
    unanchored,
    vsCurrentPipeline: {
      expected: expected.length,
      exact,
      shifted,
      missing,
      extra: actual.filter((a) => !used.has(a.id)).map((a) => `${a.id} [${a.start}-${a.end}] ${a.text}`),
    },
  };
}
