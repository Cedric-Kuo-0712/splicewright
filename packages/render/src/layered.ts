import { bezier, itemSpan, keyframeFrame, transitionOf, type AudioItem, type OverlayItem, type Project, type Track, type VideoItem } from "@splicewright/core";
import type { Probe } from "@splicewright/core/node";

export interface LayeredSegment {
  item: VideoItem;
  start: number;
  duration: number;
  sourceIn: number;
  lead: number;
  tail: number;
  /** Visible portion of the clip's transition-extended span for this export range. */
  renderStart: number;
  renderEnd: number;
  /** Earliest bounded pre-roll needed to preserve an in-progress fade at renderStart. */
  decodeStart: number;
  incoming?: { kind: "dissolve" | "dip"; before: number; after: number };
  outgoing?: { kind: "dissolve" | "dip"; before: number; after: number };
  videoAudio: boolean;
  /** Present when the item is scaled, moved or faded: output pixels, offsets from the canvas centre (CSS translate-then-scale). */
  place?: { width: number; height: number; x: number; y: number; opacity: number; xExpr?: string; yExpr?: string };
}

export interface LayeredPlan {
  from: number;
  to: number;
  fps: number;
  width: number;
  height: number;
  background: string;
  video: LayeredSegment[];
  audio: { item: AudioItem; start: number; duration: number; renderStart: number; renderEnd: number; decodeStart: number }[];
  windows: [number, number][];
}

/** Audio gain timing from Composition.look(): dissolve crosses the full transition, dip only its own side. */
export function audioTransitionFades(segment: LayeredSegment) {
  const incoming = segment.incoming
    ? segment.incoming.kind === "dissolve" ? segment.incoming.before + segment.incoming.after : segment.incoming.after
    : undefined;
  const outgoing = segment.outgoing
    ? { start: segment.lead + segment.duration - segment.outgoing.before, duration: segment.outgoing.kind === "dissolve" ? segment.outgoing.before + segment.outgoing.after : segment.outgoing.before }
    : undefined;
  return { incoming, outgoing };
}

const supportedOverlayComponents = new Set(["Text", "Image", "Sticker", "CaptionLayer"]);
/** A preflight refusal: thrown before any browser or ffmpeg starts, so `render()` may fall back to Remotion. */
export class LayeredUnsupportedError extends Error {
  constructor(reason: string) {
    super(`layered export unsupported: ${reason}`);
    this.name = "LayeredUnsupportedError";
  }
}
const fail = (reason: string): never => { throw new LayeredUnsupportedError(reason); };
const styleHasSafeBackdrop = (style: unknown, captionDefault = false) => {
  const css = style && typeof style === "object" ? style as Record<string, unknown> : {};
  const safe = ["backdropFilter", "WebkitBackdropFilter", "webkitBackdropFilter"].every((key) => css[key] === undefined || css[key] === "none");
  return safe && (css.mixBlendMode === undefined || css.mixBlendMode === "normal") && (!captionDefault || css.backdropFilter === "none");
};
const BEZIER_STEPS = 16;
/**
 * ffmpeg expression (in `t`, seconds on the output clock) for a keyed x or y, in output pixels. Every segment is a clipped ramp and the
 * ramps are summed, so there is no nesting. Linear and "ease" (smoothstep) segments are exact; a cubic-bezier segment is sampled into
 * BEZIER_STEPS linear ramps (ceiling: the error is a fraction of a percent of the segment's travel; raise BEZIER_STEPS if it shows).
 */
function keyedExpression(project: Project, item: VideoItem, prop: "x" | "y", from: number, scale: number) {
  const keys = (item.keyframes as Record<string, { t: number; v: number; ease?: unknown }[]> | undefined)?.[prop];
  if (!keys?.length) return undefined;
  const at = (t: number) => (keyframeFrame(project, item, t) - from) / project.meta.fps;
  const num = (value: number) => String(+value.toFixed(6));
  const ramp = (delta: number, start: number, end: number) => `${num(delta)}*clip((t-${num(start)})/${num(end - start)},0,1)`;
  const terms = [num(keys[0].v * scale)];
  for (let index = 0; index + 1 < keys.length; index++) {
    const [a, b] = [keys[index], keys[index + 1]];
    const [start, end, delta] = [at(a.t), at(b.t), (b.v - a.v) * scale];
    if (!(end > start)) fail(`keyframes of ${prop} on ${item.id} must be strictly increasing`);
    if (Array.isArray(a.ease)) {
      const [x1, y1, x2, y2] = a.ease as [number, number, number, number];
      let previous = 0;
      for (let step = 1; step <= BEZIER_STEPS; step++) {
        const progress = bezier(x1, y1, x2, y2, step / BEZIER_STEPS);
        terms.push(ramp(delta * (progress - previous), start + (end - start) * (step - 1) / BEZIER_STEPS, start + (end - start) * step / BEZIER_STEPS));
        previous = progress;
      }
    } else if (a.ease === "ease") {
      const u = `clip((t-${num(start)})/${num(end - start)},0,1)`;
      terms.push(`${num(delta)}*${u}*${u}*(3-2*${u})`);
    } else terms.push(ramp(delta, start, end));
  }
  return terms.join("+");
}

/** Composition.tsx applies `translate(x, y) scale(s)` about the canvas centre, so the item's centre moves by (x, y) unscaled. */
function placement(project: Project, item: VideoItem, from: number, scale: number): LayeredSegment["place"] {
  const { x = 0, y = 0, scale: zoom = 1, opacity = 1 } = item.transform ?? {};
  const xExpr = keyedExpression(project, item, "x", from, scale), yExpr = keyedExpression(project, item, "y", from, scale);
  if (!x && !y && zoom === 1 && opacity === 1 && !xExpr && !yExpr) return undefined;
  if (!(zoom > 0)) fail("transform scale must be positive");
  return { width: Math.max(2, Math.round(project.meta.width * scale * zoom)), height: Math.max(2, Math.round(project.meta.height * scale * zoom)), x: x * scale, y: y * scale, opacity, xExpr, yExpr };
}

/** Conservative eligibility and frame mapping for the experimental native-video/Remotion-graphics path. */
export function planLayeredExport(project: Project, probes: Record<string, Probe>, from = 0, to = timelineEnd(project), scale = 1): LayeredPlan {
  if (!Number.isFinite(scale) || scale <= 0) fail("output scale must be positive");
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > timelineEnd(project)) fail(`invalid frame range [${from}, ${to})`);
  const visibleVideo = project.tracks.filter((track) => !track.hidden && track.kind === "video");
  if (!visibleVideo.length) fail("requires at least one visible video track");
  const background = project.meta.background ?? "#000";
  if (!/^(?:#[\da-f]{3}|#[\da-f]{6}|black|transparent)$/i.test(background)) fail("project background must be a simple hex color, black, or transparent");
  // Tracks run bottom (index 0) to top; graphics are composited above every video track.
  const videoTrackIndex = Math.max(...visibleVideo.map((track) => project.tracks.indexOf(track)));
  const intersects = (item: Parameters<typeof itemSpan>[1]) => {
    const span = itemSpan(project, item);
    if (!span) return false;
    const start = span.start, end = span.start + span.duration;
    return start < to && end > from;
  };
  if (project.tracks.some((track, index) => !track.hidden && index < videoTrackIndex && (track.kind === "overlay" || track.kind === "caption") && track.items.some((item) => intersects(item))))
    fail("graphics tracks below the video track cannot be preserved by layered composition");
  if (Math.round(project.meta.width * scale) < 2 || Math.round(project.meta.height * scale) < 2 || Math.round(project.meta.width * scale) % 2 || Math.round(project.meta.height * scale) % 2)
    fail("output dimensions must be positive and even for 4:2:0 video");
  const segments: LayeredSegment[] = [];
  for (const videoTrack of visibleVideo as Extract<Track, { kind: "video" }>[]) {
  const ordered = [...videoTrack.items].sort((a, b) => a.start - b.start);
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    const outgoingCandidate = transitionOf(videoTrack, item);
    const incomingCandidate = index > 0 ? transitionOf(videoTrack, ordered[index - 1]) : undefined;
    const clipStartCandidate = item.start - (incomingCandidate && incomingCandidate.kind !== "dip" ? incomingCandidate.before : 0);
    const clipEndCandidate = item.start + item.duration + (outgoingCandidate && outgoingCandidate.kind !== "dip" ? outgoingCandidate.after : 0);
    if (clipStartCandidate >= to || clipEndCandidate <= from) continue;
    if (index > 0 && ordered[index - 1].start + ordered[index - 1].duration > item.start)
      fail(`overlapping video items before ${item.id} are unsupported`);
    const asset = project.assets[item.assetId];
    const probe = probes[item.assetId];
    if (!asset || asset.kind !== "video") fail(`item ${item.id} must use a video asset`);
    if (!probe || probe.kind !== "video" || !probe.width || !probe.height || probe.audio === undefined) fail(`item ${item.id} needs a current video probe with dimensions and audio metadata`);
    if (probe.rotation || asset.rotation) fail(`item ${item.id} has rotated media`);
    if ((item.speed ?? 1) !== 1 || item.reverse) fail(`item ${item.id} uses speed or reverse playback`);
    if (item.grade || item.key || item.lutKeyframes?.length || item.crop || item.effects || item.blend && item.blend !== "normal" || item.transform?.rotation || Object.keys(item.keyframes ?? {}).some((key) => key !== "x" && key !== "y"))
      fail(`item ${item.id} uses an unsupported video look or animation`);
    if (item.audioFx) fail(`item ${item.id} uses processed audio`);
    const affectsRange = (cut: number, transition: NonNullable<ReturnType<typeof transitionOf>>) => cut - transition.before < to && cut + transition.after > from;
    const outgoingRaw = outgoingCandidate && affectsRange(item.start + item.duration, outgoingCandidate) ? outgoingCandidate : undefined;
    if (outgoingRaw && outgoingRaw.kind !== "dissolve" && outgoingRaw.kind !== "dip") fail(`${outgoingRaw.kind} transition on ${item.id} is unsupported`);
    const previous = ordered[index - 1];
    const incomingRaw = incomingCandidate && previous && affectsRange(previous.start + previous.duration, incomingCandidate) ? incomingCandidate : undefined;
    if (incomingRaw && incomingRaw.kind !== "dissolve" && incomingRaw.kind !== "dip") fail(`${incomingRaw.kind} transition into ${item.id} is unsupported`);
    if (incomingRaw && incomingRaw.next.id !== item.id) fail(`overlapping video items before ${item.id} are unsupported`);
    const incoming = incomingRaw ? { kind: incomingRaw.kind as "dissolve" | "dip", before: incomingRaw.before, after: incomingRaw.after } : undefined;
    const outgoing = outgoingRaw ? { kind: outgoingRaw.kind as "dissolve" | "dip", before: outgoingRaw.before, after: outgoingRaw.after } : undefined;
    const lead = incoming?.kind === "dissolve" ? incoming.before : 0;
    const tail = outgoing?.kind === "dissolve" ? outgoing.after : 0;
    if (item.sourceIn - lead / project.meta.fps < -1e-6 || probe.duration !== undefined && item.sourceIn + (item.duration + tail) / project.meta.fps > probe.duration + 1e-6)
      fail(`transition handles for ${item.id} exceed its probed source range`);
    if (item.fadeIn && incoming || item.fadeOut && outgoing) fail(`item ${item.id} combines clip fades with transitions`);
    const clipStart = item.start - lead;
    const clipEnd = item.start + item.duration + tail;
    const renderStart = Math.max(from, clipStart);
    const renderEnd = Math.min(to, clipEnd);
    if (renderEnd > renderStart) {
      const phaseWindows: [number, number][] = [];
      if (item.fadeIn) phaseWindows.push([item.start, item.start + item.fadeIn]);
      if (item.fadeOut) phaseWindows.push([item.start + item.duration - item.fadeOut, item.start + item.duration]);
      if (incoming?.kind === "dissolve") phaseWindows.push([clipStart, clipStart + incoming.before + incoming.after]);
      if (incoming?.kind === "dip") phaseWindows.push([item.start, item.start + incoming.after]);
      if (outgoing) phaseWindows.push([item.start + item.duration - outgoing.before, item.start + item.duration + (outgoing.kind === "dissolve" ? outgoing.after : 0)]);
      const decodeStart = Math.min(renderStart, ...phaseWindows.filter(([start, end]) => start < renderStart && end > renderStart).map(([start]) => start));
      segments.push({ item, start: item.start, duration: item.duration, sourceIn: item.sourceIn, lead, tail, renderStart, renderEnd, decodeStart, incoming, outgoing, videoAudio: !videoTrack.muted && probe.audio === true, place: placement(project, item, from, scale) });
    }
  }
  }
  if (!segments.length) fail("requires at least one video item");

  const audio: LayeredPlan["audio"] = [];
  for (const track of project.tracks) {
    if (track.hidden || track.muted || track.kind === "caption" || track.kind === "overlay" || track.kind === "video") continue;
    if (track.kind !== "audio") continue;
    for (const item of track.items) {
      const renderStart = Math.max(from, item.start);
      const renderEnd = Math.min(to, item.start + item.duration);
      if (renderEnd <= renderStart) continue;
      if (item.audioFx || item.duck || Object.keys(item.keyframes ?? {}).length) fail(`audio track ${track.id} uses processed, ducked, or animated audio`);
      const probe = probes[item.assetId];
      if (!probe || probe.kind !== "audio" || probe.audio !== true) fail(`audio item ${item.id} needs a current audio probe`);
      if (probe.duration !== undefined && item.sourceIn + item.duration / project.meta.fps > probe.duration + 1e-6)
        fail(`audio source range for ${item.id} exceeds its probed duration`);
      {
        const phaseStarts = [
          item.fadeIn && item.start < renderStart && item.start + item.fadeIn > renderStart ? item.start : undefined,
          item.fadeOut && item.start + item.duration - item.fadeOut < renderStart && item.start + item.duration > renderStart ? item.start + item.duration - item.fadeOut : undefined,
        ].filter((start): start is number => start !== undefined);
        audio.push({ item, start: item.start, duration: item.duration, renderStart, renderEnd, decodeStart: Math.min(renderStart, ...phaseStarts) });
      }
    }
  }

  for (const track of project.tracks) {
    if (track.hidden || track.kind !== "caption" && track.kind !== "overlay") continue;
    const activeItems = track.items.filter((item) => track.kind !== "caption" || ("text" in item && !!item.text)).filter((item) => intersects(item));
    if (!activeItems.length) continue;
    if (track.kind === "caption" && track.style && track.style !== "CaptionLayer") fail(`caption track ${track.id} uses a custom component`);
    const overlayItems = track.kind === "overlay" ? activeItems as OverlayItem[] : [];
    if (track.kind === "overlay" && overlayItems.some((item) => !supportedOverlayComponents.has(item.component) || item.blend && item.blend !== "normal")) fail(`overlay track ${track.id} uses a custom component or underlying-video blend mode`);
    if (track.kind === "caption" && activeItems.some((item) => "text" in item && !!item.text))
      fail(`caption track ${track.id} uses CaptionLayer's backdrop blur; use an overlay CaptionLayer with css.backdropFilter set to none`);
    if (track.kind === "overlay") for (const item of overlayItems) {
      const css = item.component === "CaptionLayer" ? item.props.css : undefined;
      const style = item.props.style;
      if (!styleHasSafeBackdrop(style) || !styleHasSafeBackdrop(css, item.component === "CaptionLayer") || !styleHasSafeBackdrop(item.props.hiCss) ||
        Object.keys(item.keyframes ?? {}).some((key) => key === "props.style" || key.startsWith("props.style.") || key === "props.css" || key.startsWith("props.css.")))
        fail(`overlay ${item.component} on ${track.id} uses a backdrop-dependent or animated style`);
    }
  }

  const intervals: [number, number][] = [];
  for (const track of project.tracks) {
    if (track.hidden || track.kind !== "caption" && track.kind !== "overlay") continue;
    for (const item of track.items) {
      if (track.kind === "caption" && (! ("text" in item) || !item.text)) continue;
      const span = itemSpan(project, item);
      if (!span) continue;
      const start = Math.max(from, span.start), end = Math.min(to, span.start + span.duration);
      if (end > start) intervals.push([start, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const windows: [number, number][] = [];
  for (const interval of intervals) {
    const last = windows.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else windows.push([...interval]);
  }
  return { from, to, fps: project.meta.fps, width: Math.round(project.meta.width * scale), height: Math.round(project.meta.height * scale), background, video: segments, audio, windows };
}

const stillOverlayComponents = new Set(["Text", "CaptionLayer"]);

/**
 * Spans inside `windows` whose graphics frame is identical on every frame, as start frame → length.
 * Only runs longer than one frame are listed. A frame composites every item showing at once, so a run
 * is a stretch where the showing set is unchanged and all of it is a keyframe-free Text or CaptionLayer.
 * Image/Sticker are treated as moving (Sticker can be an animated GIF; a still Image is not proven).
 */
export function staticRuns(project: Project, windows: readonly (readonly [number, number])[]): Map<number, number> {
  const items: { start: number; end: number; still: boolean }[] = [];
  for (const track of project.tracks) {
    if (track.hidden || track.kind !== "caption" && track.kind !== "overlay") continue;
    for (const item of track.items) {
      const span = itemSpan(project, item);
      if (!span) continue;
      const overlay = item as OverlayItem;
      items.push({ start: span.start, end: span.start + span.duration, still: track.kind === "overlay" && stillOverlayComponents.has(overlay.component) && !Object.keys(overlay.keyframes ?? {}).length });
    }
  }
  const runs = new Map<number, number>();
  for (const [from, to] of windows) {
    const live = items.filter((item) => item.start < to && item.end > from);
    const cuts = [...new Set([from, to, ...live.flatMap((item) => [item.start, item.end]).filter((frame) => frame > from && frame < to)])].sort((a, b) => a - b);
    for (let index = 0; index + 1 < cuts.length; index++) {
      const [start, end] = [cuts[index], cuts[index + 1]];
      if (end - start > 1 && live.every((item) => item.end <= start || item.start >= end || item.still)) runs.set(start, end - start);
    }
  }
  return runs;
}

function timelineEnd(project: Project) {
  return Math.max(1, ...project.tracks.flatMap((track) => track.items.flatMap((item) => {
    const span = itemSpan(project, item);
    return span ? [span.start + span.duration] : [];
  })));
}
