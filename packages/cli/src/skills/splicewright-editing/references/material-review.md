# Material review

Use this route for a new assembly, a broad source review, or new/changed footage relevant to the edit. For a local correction, inspect only the sources and timeline range that can affect it.

## Inspect in bounded batches

1. Read `list_materials` to find new, changed, missing, and already reviewed sources. Prefer a compact inventory when the live schema offers one; use selected paths and full detail only for the batch being inspected.
2. Call `prepare_materials` only for selected paths and needed steps. It registers sources and builds requested caches; it does not mean the source was reviewed.
3. Inspect evidence through the available tools: `inspect_asset` and `get_asset_transcript` for metadata or cached speech, `peek` for a bounded grid of video frames, `source_frame` for one detail that the grid cannot resolve, and `material_preview` for a bounded still-image preview. Do not open original image, video, or audio files as agent context. A filename, contact sheet path, transcript, or successful preparation alone is not a visual review.
4. Write a short factual summary and useful source-second ranges. Preserve uncertainty: unknown is unknown. Then call `record_material_review` with the exact listed `path` and `version`; its optional `segments` use source seconds, and `decision` can be `candidate`, `include`, or `exclude`. A stale source version is refused. Review records describe evidence and decisions; they do not insert or change timeline items.

For a library too large for one pass, independent batches can be assigned to capable workers when the host actually provides them and the overhead is worthwhile. Do not launch one worker per photo. Give each worker a bounded path batch, the required fields, and a request for concise evidence with uncertainty. Workers may inspect only tool-provided samples; the main editor validates their reports and writes review records. Do not let workers edit shared review JSON directly: version checks and write coordination belong to the main workflow. If workers or suitable sample tools are unavailable, inspect a smaller batch in the main session.

## Capture time and story order

Keep capture chronology separate from story chronology. Prefer explicit embedded capture time when available, and preserve whether a timestamp was embedded or inferred. Filenames and filesystem times can be renamed, copied, or generated; do not silently treat them as verified capture time. If the time is unknown, leave it unknown. Chronology is one possible organizing clue, not an instruction to arrange the finished timeline chronologically.

When a material record supplies optional `planning`, treat it as a shortlist, not a verdict: `storyRoles` can suggest `establishing`, `process`, `highlight`, `detail`, `ending`, or `hook`; `tags` and `suitableUses` (`b-roll`, `photo-montage`, `live-audio`) are retrieval hints. `coverage` names a method, whether it is `partial` or `full`, and optional source-second ranges; still images omit ranges. Keep `cautions` visible. This planning metadata does not replace source inspection or the versioned review record, and it does not enforce how a clip is used.

## Return shape for a batch

Return one compact row per source: path and version; what is visibly/audibly present; useful ranges with source seconds; uncertainty or cautions; possible story roles or uses; and any candidate/include/exclude decision with its reason. Separate observed facts from interpretation so the editor can choose among sources without replaying every source for a local refinement.
