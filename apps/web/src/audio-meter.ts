/** Measures sampled browser playback amplitude. This does not inspect a rendered export or true peak. */
export function measurePeak(samples: Float32Array): { peakDb: number; clipping: boolean } | null {
  if (!samples.length) return null;
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return { peakDb: peak === 0 ? -Infinity : 20 * Math.log10(peak), clipping: peak >= 0.999 };
}

let graph: { context: AudioContext; mixer: GainNode; analysers: AnalyserNode[] } | null = null;
const connected = new WeakSet<HTMLMediaElement>();

function playbackGraph() {
  if (graph) return graph;
  const AudioContextCtor = window.AudioContext;
  if (!AudioContextCtor) return null;
  const context = new AudioContextCtor();
  const mixer = context.createGain();
  mixer.channelCount = 2;
  mixer.channelCountMode = "explicit";
  const splitter = context.createChannelSplitter(2);
  const analysers = [context.createAnalyser(), context.createAnalyser()];
  mixer.connect(splitter);
  analysers.forEach((analyser, channel) => {
    analyser.fftSize = 1024;
    splitter.connect(analyser, channel);
  });
  // AnalyserNode downmixes to mono: split first so opposite-phase stereo cannot hide clipping.
  // Only the mixer drives playback; both analysis taps remain disconnected from the destination.
  mixer.connect(context.destination);
  graph = { context, mixer, analysers };
  return graph;
}

/** Connects each native Remotion audio/video source once while the Player is playing. */
export function samplePlayerAudio(root: HTMLElement, sample: (reading: ReturnType<typeof measurePeak> | null, available: boolean) => void) {
  let audio = playbackGraph();
  if (!audio) {
    sample(null, false);
    return () => {};
  }
  void audio.context.resume().catch(() => sample(null, false));
  let failed = false;
  const buffers = audio.analysers.map((analyser) => new Float32Array(analyser.fftSize));
  const timer = window.setInterval(() => {
    try {
      if (audio!.context.state !== "running") return sample(null, false);
      let attached = 0;
      for (const element of root.querySelectorAll<HTMLMediaElement>("audio,video")) {
        if (!connected.has(element)) {
          const source = audio!.context.createMediaElementSource(element);
          source.connect(audio!.mixer);
          connected.add(element);
        }
        attached++;
      }
      if (!attached) return sample(null, !failed);
      audio!.analysers.forEach((analyser, channel) => analyser.getFloatTimeDomainData(buffers[channel]));
      sample(measureStereoPeak(buffers), !failed);
    } catch {
      failed = true;
      sample(null, false);
    }
  }, 50);
  return () => window.clearInterval(timer);
}

/** Maximum channel peak, never a mono downmix. */
export function measureStereoPeak(channels: Float32Array[]) {
  let reading: ReturnType<typeof measurePeak> = null;
  for (const channel of channels) {
    const peak = measurePeak(channel);
    if (peak && (!reading || peak.peakDb > reading.peakDb)) reading = peak;
  }
  return reading;
}
