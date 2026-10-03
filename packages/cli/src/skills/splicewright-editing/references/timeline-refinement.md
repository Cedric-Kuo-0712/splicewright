# Timeline refinement

Use this route for a local change to an existing edit. Read the smallest affected `get_range`/`get_item` evidence, relevant track fields, and only the sources needed to judge that change. Reuse valid material reviews; review again only if a source changed or the existing evidence cannot settle the decision.

## Plan the local edit

Write down the target item or cut, the intended change, and its exit condition. Keep the existing shot order, music placement, and important cut anchors unless the request explicitly changes them. Prefer a direct item/property edit (`trim`, `slip`, or `setProps`, for example) when it solves the issue without moving surrounding material. Do not re-review or re-open the full library to adjust one clip.

## Decide how timing should propagate

Identify direct targets by item IDs at the revision you read, not only their clock times. Separate direct content edits from permitted secondary timing changes: shortening 20–30 seconds may legitimately shift later items earlier, but does not authorize changing their source ranges, order, effects, or duration. State the permitted downstream movement and fixed music/section anchors before editing.

Ripple behavior is track-local by default. Optional track `syncTo` links let free downstream items follow an unsynced magnetic video primary track; inspect those links in the summary before a timing edit. Attached overlays and anchored captions still follow their video anchor. Unlinked music and sound items do not automatically follow. A linked free item spanning a splice boundary is ambiguous and refuses the edit; never silently split or unlink it. After timing changes, inspect every relevant track, music, captions, and section markers.

Choose a timing policy in the edit plan; track sync enforces configured downstream movement, but does not enforce an entire creative edit-scope contract:

- **Preserve later timing:** request no ripple for a local trim when later items should stay at their timeline frames. Check for gaps or overlaps that result.
- **Ripple later items:** use ripple when the downstream items on that track should close or follow the change. Review the moved items and decide explicitly whether independent music or other tracks should move too.

Do not assume one policy for the whole project. State which anchors must stay fixed before applying a change that can shift later items.

## Apply and review one round

Use `preview_edit` with proposed operations and the current `baseRevision` to inspect direct and secondary movement without writing. Submit the approved round with that same revision. If anything changed since preview, re-read and re-plan; preview does not reserve the timeline.

After agreement on a substantial change, submit one coherent atomic round with `apply_edit_review`; it records one revision/undo step and before/after snapshots. Use `splicewright_batch` for an ordinary atomic edit where a review record is not needed. Pass the revision you read. If it is stale, re-read and re-plan. Do not silently unlock a track, overwrite a human edit, or undo a newer human revision.

Re-read the affected range after the write. Confirm item order, cut frames, anchored overlays/captions, and independent audio placement. Use a few stills or a storyboard around the changed section; run `lint` before render. For animation, check entry, middle, and exit. For sound, use available audio measurements and reserve listening/subjective quality for human review; do not load raw audio into agent context.
