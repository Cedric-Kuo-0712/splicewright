# Optional engines: agent-operated, isolated from the editor

Use these only when the scene benefits from their native objects or sequential
authoring. They do not change `project.json` or install globally. Sources remain
editable in `animations/`; environments/build outputs are local and disposable.

## Prepare

From the video project's root:

```sh
python3 .agents/skills/splicewright-animation/scripts/setup_engine.py motion-canvas --dir animations/motion-canvas --install
python3 .agents/skills/splicewright-animation/scripts/setup_engine.py manim --dir animations/manim --install
```

Choose one command, not both automatically. Omit `--install` to scaffold only.
Existing source files are preserved. Manim needs native Cairo/Pango and their
build metadata; the script reports missing prerequisites rather than installing
system packages. Keep dependency-install and rendering logs. If preparation
will take a long time, follow the project's detached-job policy.

## Motion Canvas

The scaffold pins Motion Canvas 3.17.2 and provides a small agent bridge with
only status/render, not a copied 600-line editor-control skill/plugin. Edit
`src/scene.tsx`. `npm run typecheck`, then run `npm run dev` in that folder,
using the project's server/long-job policy. The server binds to 127.0.0.1:9000.

Open that URL through an available browser tool; the user does not need to
operate the editor. This engine still needs an actual browser: a build passing
does not prove render readiness. Do not invent a headless CLI command. If the
environment has no browser surface, use Remotion or Manim instead and explain why.

```sh
curl --fail http://127.0.0.1:9000/__splicewright/status
curl --fail -X POST http://127.0.0.1:9000/__splicewright/render \
  -H 'Content-Type: application/json' -d '{"fps":30,"width":1920,"height":1080}'
```

Status requires a connected project with a renderer. With several browser tabs
open, only the newest one is asked. If the renderer does not answer within 2 s
the response is a 503 carrying the job ID: the render may still have started, so
check `.agent-render/<id>.json` before sending it again. Render returns an accepted
job ID, **not completion**. The bridge records completion in `.agent-render/<id>.json`
when the native renderer finishes; result `complete`, `failed` or `aborted`.
Do not poll for completion. Follow the existing runner/notification policy or
check on demand. A browser closed midway cannot produce a successful completion.

The default exporter produces an image sequence under `output/`. Inspect the
actual file naming before using ffmpeg to encode at the project fps. Use an
alpha-capable output when this is an overlay, otherwise a full-frame insert.
Do not label an opaque H.264 file a transparent sticker. Import the verified
output through the editor and retain the scene sources for future revisions.

## Manim

Edit `scene.py` (`TravelScene` is the starter class). Run the isolated interpreter:

```sh
animations/manim/.venv/bin/python -m manim -r 1920,1080 --fps 30 \
  --media_dir animations/manim/output animations/manim/scene.py TravelScene
```

On Windows the venv interpreter is `.venv/Scripts/python.exe`. Use project
dimensions/fps and the actual class name. The starter avoids LaTeX dependencies;
formula rendering may require a separate LaTeX installation. Use native scene
objects for real mathematical explanations, not as a replacement for ordinary
vlog labels. Verify the actual generated file with `ffprobe`, then import it.

## API sources and limits

The scaffold and bridge are original minimal project code; no external skills
are downloaded during init. Defaults are pinned to APIs checked against installed
types. Optional engine setup requires network access unless dependencies are cached.

- [Motion Canvas scene generators](https://motioncanvas.io/docs/quickstart/)
- [Native rendering/exporters](https://github.com/motion-canvas/motion-canvas/blob/main/packages/docs/docs/getting-started/rendering/index.mdx)
- [VideoZero agent bridge architecture](https://github.com/VideoZero/skills/tree/d90f87c44bc7109147d094603e33da43c217799b/motion-canvas-agent) (reference, not vendored)
- [Manim](https://github.com/ManimCommunity/manim)
