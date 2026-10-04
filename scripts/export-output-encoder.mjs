/** FFmpeg codec options before an input's -i select decoders, not the export encoder. */
export function outputVideoEncoder(args) {
  const lastInput = args.lastIndexOf('-i');
  let encoder;
  // These benchmark exports have one output. Later aliases override earlier
  // options within its output scope, just as FFmpeg applies them.
  for (let index = lastInput < 0 ? 0 : lastInput + 2; index < args.length - 1; index++) {
    if (/^-(?:c:v|codec:v|vcodec)(?::0)?$/.test(args[index])) encoder = args[++index];
  }
  return encoder;
}
