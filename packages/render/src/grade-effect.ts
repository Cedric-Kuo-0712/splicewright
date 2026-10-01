import { createEffect, type EffectDefinition } from "remotion";
import type { Lut } from "cube-lut.js/dist/types.js";

export type GradeGpuParams = {
  curves: { all?: [number, number][]; r?: [number, number][]; g?: [number, number][]; b?: [number, number][] };
  lut?: GradeLut;
  strength: number;
  outBlack?: number;
  outWhite?: number;
};
type State = { gl: WebGL2RenderingContext; program: WebGLProgram; source: WebGLTexture; curves: WebGLTexture; lut: WebGLTexture; vao: WebGLVertexArrayObject; floatLinear: boolean; uploaded?: Lut };
/** A parsed LUT with the SHA-256 (hex) of its .cube text, computed once where it is parsed (`lutsOf`). */
export type GradeLut = Lut & { digest: string };
/** Remotion reuses the previous effect, params included, while this key is unchanged, so it must tell two
 * tables apart for certain; the digest does that without stringifying a 65³ table (~4 MB) per call. */
export const gradeKey = (p: GradeGpuParams) => JSON.stringify({ ...p, lut: p.lut?.digest });
const vertex = `#version 300 es\nconst vec2 p[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.)); out vec2 uv; void main(){ gl_Position=vec4(p[gl_VertexID],0.,1.); uv=(p[gl_VertexID]+1.)*.5; }`;
const fragment = `#version 300 es
precision highp float; precision highp sampler3D; in vec2 uv; out vec4 color;
uniform sampler2D uSource; uniform sampler2D uCurves; uniform sampler3D uLut; uniform bool useLut; uniform float strength; uniform float outBlack; uniform float outWhite; uniform vec3 dmin; uniform vec3 dmax;
float curve(float x,int channel){vec4 v=texture(uCurves,vec2((clamp(x,0.,1.)*255.+.5)/256.,.5)); if(channel==0)return v.r; if(channel==1)return v.g; if(channel==2)return v.b; return v.a;}
void main(){vec4 src=texture(uSource,uv); float alpha=src.a; vec3 c=alpha>0.00001?src.rgb/alpha:vec3(0.); c=mix(vec3(outBlack),vec3(outWhite),c); c=vec3(curve(c.r,0),curve(c.g,1),curve(c.b,2)); c=vec3(curve(c.r,3),curve(c.g,3),curve(c.b,3)); if(useLut){ivec3 sz=textureSize(uLut,0); vec3 q=clamp((c-dmin)/(dmax-dmin),0.,1.); vec3 mapped=texture(uLut,(q*vec3(sz-ivec3(1))+.5)/vec3(sz)).rgb; c=mix(c,mapped,strength);} color=vec4(c*alpha,alpha);}`;
function compile(gl: WebGL2RenderingContext, kind: number, source: string) { const shader = gl.createShader(kind)!; gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "look shader compile failed"); return shader; }
export function curveTable(points: [number, number][] = [[0, 0], [1, 1]]) {
  const out = new Float32Array(256);
  // Shape-preserving monotone Hermite interpolation (Fritsch-Carlson); endpoint clamp by design.
  const x = points.map((p) => p[0]), y = points.map((p) => p[1]);
  const d = x.slice(1).map((_, i) => (y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  const h = x.slice(1).map((_, i) => x[i + 1] - x[i]);
  const endpoint = (h0: number, h1: number, d0: number, d1: number) => {
    let slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (slope * d0 <= 0) slope = 0;
    else if (d0 * d1 < 0 && Math.abs(slope) > 3 * Math.abs(d0)) slope = 3 * d0;
    return slope;
  };
  const m = x.map((_, i) => {
    if (i === 0) return x.length === 2 ? d[0] : endpoint(h[0], h[1], d[0], d[1]);
    if (i === x.length - 1) return x.length === 2 ? d[d.length - 1] : endpoint(h[h.length - 1], h[h.length - 2], d[d.length - 1], d[d.length - 2]);
    if (d[i - 1] * d[i] <= 0) return 0;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    return (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  });
  for (let j = 0; j < 256; j++) { const v = j / 255; let i = 0; while (i < x.length - 2 && v > x[i + 1]) i++; const h = x[i + 1] - x[i], t = Math.max(0, Math.min(1, (v - x[i]) / h)); const t2 = t * t, t3 = t2 * t; out[j] = Math.max(0, Math.min(1, (2*t3-3*t2+1)*y[i]+(t3-2*t2+t)*h*m[i]+(-2*t3+3*t2)*y[i+1]+(t3-t2)*h*m[i+1])); }
  return out;
}
export function curveTexture(points: GradeGpuParams["curves"]) {
  const rows = [curveTable(points.r), curveTable(points.g), curveTable(points.b), curveTable(points.all)];
  const data = new Uint8Array(256 * 4);
  // One 256x1 RGBA texture carries red, green, blue and master curves in its four channels.
  for (let i = 0; i < 256; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(rows[c][i] * 255);
  return data;
}
function definition(): EffectDefinition<GradeGpuParams, State> {
  return { type: "splicewright-grade", label: "Grade curves and LUT", documentationLink: null, backend: "webgl2", calculateKey: gradeKey, schema: {}, validateParams: () => {},
    setup(target) {
      const gl = target.getContext("webgl2", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true })!;
      if (!gl) throw new Error("WebGL2 required for curves and LUT");
      const floatLinear = !!gl.getExtension("OES_texture_float_linear"); // only a LUT needs it; curves alone work without
      const program = gl.createProgram()!; gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex)); gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "look shader link failed");
      const tex = () => { const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); return t; };
      const source = tex(), curves = tex(), lut = gl.createTexture()!, vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      gl.bindTexture(gl.TEXTURE_3D, lut); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      return { gl, program, source, curves, lut, vao, floatLinear };
    },
    apply({ source, target, state, params, width, height, flipSourceY }) {
      const { gl } = state; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, state.source);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipSourceY ? 1 : 0); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, state.curves); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, curveTexture(params.curves));
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, state.lut);
      const data = params.lut?.data;
      if (data && !state.floatLinear) throw new Error("WebGL float texture filtering unavailable for 3D LUT");
      if (data && state.uploaded !== params.lut) { const rgba = new Float32Array(data.length * 4); data.forEach((v, i) => { rgba[i*4]=v[0]; rgba[i*4+1]=v[1]; rgba[i*4+2]=v[2]; rgba[i*4+3]=1; }); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, params.lut!.size, params.lut!.size, params.lut!.size, 0, gl.RGBA, gl.FLOAT, rgba); state.uploaded = params.lut; }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.useProgram(state.program); gl.uniform1i(gl.getUniformLocation(state.program,"uSource"),0); gl.uniform1i(gl.getUniformLocation(state.program,"uCurves"),1); gl.uniform1i(gl.getUniformLocation(state.program,"uLut"),2); gl.uniform1i(gl.getUniformLocation(state.program,"useLut"),data ? 1 : 0); gl.uniform1f(gl.getUniformLocation(state.program,"strength"),params.strength); gl.uniform1f(gl.getUniformLocation(state.program,"outBlack"),params.outBlack ?? 0); gl.uniform1f(gl.getUniformLocation(state.program,"outWhite"),params.outWhite ?? 1); gl.uniform3fv(gl.getUniformLocation(state.program,"dmin"),params.lut?.domain.min ?? [0,0,0]); gl.uniform3fv(gl.getUniformLocation(state.program,"dmax"),params.lut?.domain.max ?? [1,1,1]); gl.bindVertexArray(state.vao); gl.drawArrays(gl.TRIANGLES,0,3); gl.bindVertexArray(null);
    }, cleanup(state) { state.gl.deleteProgram(state.program); state.gl.deleteTexture(state.source); state.gl.deleteTexture(state.curves); state.gl.deleteTexture(state.lut); state.gl.deleteVertexArray(state.vao); } };
}
export const gradeEffect = createEffect(definition());
