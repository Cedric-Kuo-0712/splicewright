import type { Lut } from "cube-lut.js/dist/types.js";

// cube-lut.js 1.0.2's published ESM imports `./validate` without `.js`, which Node ESM rejects.
// Keep its Lut shape and strict .cube directives while parsing here so CLI/MCP import works in Node.
const TITLE = /^TITLE\s+"(.*)"$/;
function parse(text: string): Lut {
  const lut: Lut = { type: "3D", size: 0, domain: { min: [0, 0, 0], max: [1, 1, 1] }, data: [] };
  let sizeSeen = false, minSeen = false, maxSeen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    // The raw line first: a quoted title may contain '#', which starts a comment everywhere else.
    const title = TITLE.exec(raw.trim()) ?? TITLE.exec(line);
    if (title) { lut.title = title[1]; continue; }
    const range = /^LUT_[13]D_INPUT_RANGE\s+([^\s]+)\s+([^\s]+)$/.exec(line);
    if (range) {
      const [min, max] = [Number(range[1]), Number(range[2])];
      if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("non-finite input range");
      if (minSeen || maxSeen) throw new Error("duplicate domain declaration");
      minSeen = maxSeen = true; lut.domain.min = [min, min, min]; lut.domain.max = [max, max, max]; continue;
    }
    const dimension = /^(LUT_1D_SIZE|LUT_3D_SIZE)\s+(\d+)$/.exec(line);
    if (dimension) {
      if (sizeSeen) throw new Error("multiple LUT size declarations");
      sizeSeen = true; lut.type = dimension[1] === "LUT_1D_SIZE" ? "1D" : "3D"; lut.size = Number(dimension[2]); continue;
    }
    const domain = /^(DOMAIN_MIN|DOMAIN_MAX)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)$/.exec(line);
    if (domain) {
      const values = domain.slice(2).map(Number) as [number, number, number];
      if (!values.every(Number.isFinite)) throw new Error("non-finite domain value");
      if (domain[1] === "DOMAIN_MIN") { if (minSeen) throw new Error("duplicate DOMAIN_MIN"); minSeen = true; lut.domain.min = values; }
      else { if (maxSeen) throw new Error("duplicate DOMAIN_MAX"); maxSeen = true; lut.domain.max = values; }
      continue;
    }
    const rgb = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)$/i.exec(line);
    if (!rgb) throw new Error(`unrecognized .cube line: ${line.slice(0, 80)}`);
    const triplet = rgb.slice(1).map(Number) as [number, number, number];
    if (!triplet.every(Number.isFinite)) throw new Error(".cube LUT contains non-finite values");
    lut.data.push(triplet);
  }
  if (!sizeSeen) throw new Error("missing LUT_3D_SIZE declaration");
  return lut;
}

/** Parse and constrain a .cube file to the renderer's supported 3D texture size. */
export function parseCube(text: string) {
  const lut = parse(text);
  if (lut.type !== "3D") throw new Error("only 3D .cube LUTs are supported");
  if (!Number.isInteger(lut.size) || lut.size < 2 || lut.size > 65 || lut.data.length !== lut.size ** 3)
    throw new Error("3D .cube LUT size must be 2..65 with exactly size³ entries");
  if (![...lut.domain.min, ...lut.domain.max, ...lut.data.flat()].every(Number.isFinite))
    throw new Error(".cube LUT contains non-finite values");
  if ([0, 1, 2].some((c) => lut.domain.min[c] >= lut.domain.max[c]))
    throw new Error(".cube DOMAIN_MIN must be below DOMAIN_MAX for every channel");
  return lut;
}
