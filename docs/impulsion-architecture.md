# OpenCut Impulsion fork - architecture map

Repo: `~/impulsion/opencut`, branch `impulsion` (HEAD `cf5e79e9`, OpenCut classic, archived upstream, MIT). All paths below are relative to that root unless absolute. Dev server: `next dev --turbopack -p 3456`, reachable at `http://localhost:3456`.

This map merges eight parallel reader reports. Wherever the readers disagreed, the code was re-read (read-only) and the finding marked **verified** is what the code says. Section 11.3 lists the contradictions that were resolved this way.

---

## 0. Summary

- The editor runs entirely in the browser. `EditorCore.getInstance()` (`apps/web/src/core/index.ts`) is a module singleton with 12 managers. Every edit is a `Command` passed to `editor.command.execute({ command })`, and undo restores whole-`SceneTracks` snapshots. Projects are stored in IndexedDB and media bytes in OPFS, both tied to the origin `http://localhost:3456`. No backend is needed to edit.
- **Consequence:** Claude can only act through the open editor tab. Node cannot read the project state, and a headless browser would not see the user's Chrome profile.
- **Recommended topology:**
  - One local sidecar Node process, `apps/bridge`, bound to `127.0.0.1:3457`.
  - It hosts (a) a WebSocket hub the editor tab connects to, (b) a Streamable-HTTP MCP endpoint `/mcp` shared by every Claude Code CLI session, (c) the chat backend for the in-app panel, which calls `@anthropic-ai/claude-agent-sdk` `query()` against the installed `claude` binary on the user's Max subscription, (d) `/files` to serve disk media and `/exports` to receive rendered files, and (e) a warm Python worker for WhisperX and the other Impulsion scripts.
  - Tool handlers are written once. In the tab they run against `EditorCore`: each mutating tool is one `BatchCommand`, so it is one Cmd+Z.
- **Chat panel:** a fourth, collapsible column on the right of `EditorLayout` (`apps/web/src/app/editor/[project_id]/page.tsx`), toggled from `EditorHeader`. Chat state lives in a zustand store.
- **AI edits** go through Command classes, never `invokeAction` (stale React closures) and never raw `timeline.updateTracks` (no undo). Ripple is pinned off while an AI edit runs, and multi-track cuts are computed explicitly.
- **Transcription:** replace the in-browser, segment-level Whisper with the user's WhisperX large-v3-turbo plus French wav2vec2 alignment (`plan.transcribe_x`). Store transcripts per `mediaId` in source seconds and project them through the timeline. Text-based cuts become a pure `removeTimeRanges(tracks, ranges)` applied with one `TracksSnapshotCommand`.

Suggested build order:
1. Clean the shell (section 6) and fix the upstream bugs listed in 6.3.
2. Bridge core: WS hub, `get_editor_state`, `apply_edit_plan`, `capture_frame`, MCP registration.
3. Import from disk, export to disk.
4. Chat panel with the Agent SDK.
5. WhisperX transcripts, `cut_ranges`, word-timed captions.
6. The Impulsion signature tools (section 10).

```
 Chrome tab http://localhost:3456/editor/<id>             sidecar 127.0.0.1:3457 (Node 22, tsx)
 +--------------------------------------+   WS /editor   +-----------------------------------------+
 | EditorCore singleton (managers)      |<-------------->| hub: rpc {id,method,params} + chat chan |
 | ClaudeBridge client (tool handlers)  |  rpc + chat    | /mcp  Streamable HTTP MCP (SDK 1.30.x)  |<-- claude (CLI) sessions A/B
 | Chat panel (zustand store)           |                | chat: Agent SDK query() -> claude bin   |
 | IndexedDB + OPFS (origin-bound)      |<-- fetch ------| /files?path= (Range, allow-list)        |
 +--------------------------------------+ -- POST ------>| /exports (writes mp4/webm to disk)      |
                                                         | python worker (/usr/local/bin/python3)  |
                                                         +-----------------------------------------+
```

---

## 1. How the editor works

### 1.1 EditorCore

`apps/web/src/core/index.ts`, `export class EditorCore`:
- Private constructor, lazy `static getInstance()`. `static reset()` exists but has no caller.
- The constructor calls `registerDefaultEffects()` and `registerDefaultMasks()`, then creates the public readonly managers `command`, `timeline`, `playback`, `scenes`, `project`, `media`, `renderer`, `save`, `audio`, `selection`, `clipboard`, `diagnostics`.
- It also calls `registerTranscriptionDiagnostics`, calls `playback.bindTimelineScope()`, registers one command reactor, and starts autosave (`save.start()`).

**The reactor (verified):** after every `execute` and `redo`, but not after `undo`, it drops every overlay track and audio track with zero elements. It writes the result through `timeline.updateTracks` (no history entry). Consequence: an `AddTrackCommand` on its own is erased at once. It must share a `BatchCommand` with the inserts that fill the track.

**No global handle (verified):** nothing puts the editor on `window`. React reaches it through `useEditor(selector?)` (`apps/web/src/editor/use-editor.ts`, `useSyncExternalStore` over 9 managers). Commands call `EditorCore.getInstance()` directly. Code bundled into the app, such as the bridge client, can simply import `EditorCore`. Note that `useEditor` also calls `getInstance()` during SSR, so bridge code must be guarded with `typeof window !== "undefined"`.

### 1.2 State and notification

- Each manager keeps private fields, a `listeners: Set<() => void>`, `subscribe()` and a private `notify()`. Zustand is only used for UI preferences: `useTimelineStore` (snapping, ripple, persisted as "timeline-store"), `usePanelStore` ("panel-sizes" v2), `useKeybindingsStore` ("opencut-keybindings" v7), `usePreviewStore`, `useAssetsPanelStore`.
- State is immutable with structural sharing. The source of truth for the timeline is `ScenesManager`'s active `TScene.tracks: SceneTracks`. `ProjectManager.active: TProject` is rebuilt from it on every change.
- The ripple flag is duplicated. `useTimelineStore.rippleEditingEnabled` is copied into `editor.command.isRippleEnabled` by an effect in `EditorRuntimeBindings` (`apps/web/src/components/providers/editor-provider.tsx`) whose dependencies are `[editor, rippleEditingEnabled]`. **Verified:** the effect only re-runs when the store value changes. A synchronous save, set, execute, restore of `editor.command.isRippleEnabled` inside one call is therefore safe.

### 1.3 Mutation lifecycle (verified in `apps/web/src/core/managers/commands.ts`)

1. The caller builds a `Command` (`apps/web/src/commands/base-command.ts`: `abstract execute(): CommandResult | undefined; undo(); redo()`, where `CommandResult = { selection?: EditorSelectionPatch }`).
2. `CommandManager.execute({ command })`. If ripple is on, it snapshots `beforeTracks`, then snapshots the selection.
3. `command.execute()`. Almost every command stores `editor.scenes.getActiveScene().tracks` as `savedState`, computes new tracks and calls `editor.timeline.updateTracks(next)`.
4. `TimelineManager.updateTracks` clears the drag-preview overlay, calls `scenes.updateSceneTracks` (which notifies scene listeners and runs `project.setActiveProject`), then notifies timeline listeners.
5. Back in `CommandManager`: `applyRippleIfEnabled` (runs `computeRippleAdjustments` and `applyRippleAdjustments` from `apps/web/src/ripple`, then calls `updateTracks` again), then `applySelectionOverride`, then the reactors. The `{command, previousSelection, selectionOverride}` entry is pushed onto `history` and `redoStack` is cleared. It returns `command`.
6. `SaveManager` (`apps/web/src/core/managers/save-manager.ts`) sees the notifications, calls `markDirty()`, and saves after an 800 ms debounce.

### 1.4 Undo, redo and batching

- `undo()` pops an entry and calls `command.undo()`. It restores the selection only if the command declared a selection override, and it does not run the reactors. `redo()` re-runs ripple and the reactors. `canUndo()` and `canRedo()` exist.
- There is **no `subscribe`** on `CommandManager`, **no labels**, and `clear()` **has no caller**, even in `ProjectManager.loadProject` (verified). History is memory-only and survives a project switch in the same tab.
- `BatchCommand(commands: Command[])` (`apps/web/src/commands/batch-command.ts`) executes in order and undoes in reverse, and forms one history entry. It is **not atomic**: if a sub-command throws (for example `MoveElementCommand` on an invalid ref), the earlier sub-commands have already written tracks and nothing is pushed to history.
- Some commands **fail silently but still land in history**. `InsertElementCommand` logs and returns `undefined` on bad input; its `getTrackId()` then stays `null`. `UpdateElementsCommand` skips unknown refs.
- Nested history entries: `RemoveMediaAssetCommand.execute` calls `editor.timeline.deleteElements(...)` (line 80), and so does the failure path of `AddMediaAssetCommand` (line 85). Each pushes an extra entry.
- Drag path: `timeline.previewElements()`, then `commitPreview()`, which records a `TracksSnapshotCommand({before, after})` through `command.push()` (history only, and ripple is skipped). `timeline.isPreviewActive()` exposes that state.
- `TracksSnapshotCommand` (`apps/web/src/commands/timeline/tracks-snapshot.ts`) is the undoable escape hatch: `execute` calls `updateTracks(after)`, `undo` calls `updateTracks(before)`. Placement and validation rules are skipped.
- `PreviewTracker` (`apps/web/src/commands/preview-tracker.ts`) was dead code and has been deleted in the fork.

### 1.5 Persistence

`storageService` (`apps/web/src/services/storage/service.ts`) stores:

| Data | Store |
|---|---|
| Projects (one `SerializedProject` per project: scenes and tracks inline, ISO dates, `AudioBuffer`s stripped) | IndexedDB `video-editor-projects` / `projects` (keyPath `id`) |
| Media metadata (`MediaAssetData`) | IndexedDB `video-editor-media-${projectId}` / `media-metadata` |
| Media bytes | OPFS directory `media-files-${projectId}`, file name = asset UUID (`apps/web/src/services/storage/opfs-adapter.ts`) |
| Saved sounds | IndexedDB `video-editor-saved-sounds` |

- **Saving:** `SaveManager` subscribes to scenes and timeline, uses an 800 ms debounce, then runs `project.saveCurrentProject()` and `storageService.saveProject`. `flush()`, `markDirty({force})`, `pause()`, `resume()` and `getIsDirty()` exist. `UpdateProjectSettingsCommand` calls `save.markDirty()` itself. Media bytes are written outside SaveManager: `MediaManager.addMediaAsset` awaits the write and cannot be undone, while `AddMediaAssetCommand` can be undone but writes fire-and-forget.
- **Loading** (`ProjectManager.loadProject({id})`): pause saving, run `ensureStorageMigrations()`, clear assets and scenes, `storageService.loadProject`, `scenes.initializeScenes`, `media.loadProjectMedia`, `loadFonts` for the text families in use, build a thumbnail if missing, resume saving. The media `File` returned from OPFS is disk-backed and read lazily, so reopening a project with large rushes is cheap.
- **Not-found trap (verified):** `loadProject` throws "not found". `EditorProvider` catches it, calls `createNewProject({name: "Untitled Project"})` and runs `router.replace`. A bridge `open_project` must validate the id against `getSavedProjects()` first.
- `CURRENT_PROJECT_VERSION = 31` (`apps/web/src/services/storage/migrations/index.ts`). Migrations are additive only (`apps/web/src/services/storage/migrations/AGENTS.md`).
- Last writer wins: two tabs on the same project overwrite each other.
- There is no project JSON export or import, although the stored record is already JSON-safe.

---

## 2. Timeline data model an agent must know

### 2.1 Units (the number one source of bugs)

| Quantity | Unit | Conversion |
|---|---|---|
| Every element `startTime`, `duration`, `trimStart`, `trimEnd`, `sourceDuration`; bookmark `time` and `duration`; `playback.getCurrentTime()`; `timeline.getTotalDuration()` | `MediaTime`: branded integer ticks, `TICKS_PER_SECOND = 120_000` (`rust/crates/time/src/media_time.rs`) | `mediaTimeFromSeconds({seconds})`, `mediaTimeToSeconds({time})`, `roundMediaTime({time})`, `roundFrameTime({time, fps})`, `clampMediaTime`, `addMediaTime`/`subMediaTime` (these throw on non-integers). All exported from `apps/web/src/wasm/media-time.ts` (`@/wasm`) |
| Keyframe `time` | element-local ticks, `0..duration` | |
| `MediaAsset.duration`, `TranscriptionSegment.start/end`, `CaptionChunk`/`SubtitleCue` `startTime`/`duration` | float seconds | |
| Project fps | `FrameRate {numerator, denominator}` (opencut-wasm) | `frameRateToFloat`, `floatToFrameRate` (`apps/web/src/fps/utils.ts`) |

Ticks per frame = `120000 * den / num`: 30 fps = 4000, 25 = 4800, 24 = 5000, 29.97 = 4004, 60 = 2000.

**Rule for every tool:** the schema takes seconds (3 decimals). The browser converts once with `mediaTimeFromSeconds` and snaps with `roundFrameTime`. Each end is derived as start plus duration, never rounded independently.

### 2.2 Shapes (verified from `apps/web/src/timeline/types.ts` and `apps/web/src/project/types.ts`)

```ts
TProject { metadata{id,name,duration:MediaTime,createdAt,updatedAt,thumbnail?}, scenes: TScene[], currentSceneId,
           settings{ fps: FrameRate, canvasSize{width,height}, canvasSizeMode?, background: {type:"color",color}|{type:"blur",blurIntensity} },
           version: 31, timelineViewState? }
TScene   { id, name, isMain, tracks: SceneTracks, bookmarks: Bookmark[], createdAt: Date, updatedAt: Date }
SceneTracks { overlay: OverlayTrack[] /* [0] = TOP layer */, main: VideoTrack /* bottom, permanent */, audio: AudioTrack[] }
// display order: [...overlay, main, ...audio]
Track kinds (TrackType = "video"|"text"|"audio"|"graphic"|"effect"):
  video {elements:(video|image)[], muted, hidden}   text {text[], hidden}   graphic {(sticker|graphic)[], hidden}
  effect {effect[], hidden}                         audio {audio[], muted}
BaseTimelineElement { id, name, startTime, duration /*timeline ticks*/, trimStart, trimEnd /*source ticks*/,
                      sourceDuration?, animations?: ElementAnimations, params: Record<string, number|string|boolean> }
video   { mediaId, isSourceAudioEnabled?, hidden?, retime?: {rate, maintainPitch?}, effects?: Effect[], masks?: Mask[] }
image   { mediaId, hidden?, effects?, masks? }
text    { hidden?, effects? }                       // content + style live in params
sticker { stickerId: "provider:value", intrinsicWidth?, intrinsicHeight?, hidden?, effects? }
graphic { definitionId: "rectangle"|"ellipse"|"polygon"|"star", hidden?, effects?, masks? }
audio   { sourceType:"upload", mediaId } | { sourceType:"library", sourceUrl };  retime?; buffer?: AudioBuffer /* runtime only */
effect  { effectType: "blur" }                      // adjustment layer over everything below it
ElementRef { trackId, elementId }     Bookmark { time, note?, color?, duration? }
CreateTimelineElement = Omit<X, "id">
MediaAsset (apps/web/src/media/types.ts) = MediaAssetData minus size/lastModified + { file: File; url?: string }
  MediaAssetData { id, name, type: "video"|"image"|"audio", size, lastModified, width?, height?, duration? /*seconds*/,
                   fps?, hasAudio?, ephemeral?, thumbnailUrl? /* JPEG data URL <= 1280x720 */ }
```

### 2.3 Invariants and rules

- **Trim invariant (video, upload/library audio):** `trimStart + duration*rate + trimEnd == sourceDuration`. Images, text, stickers and graphics can be stretched without limit.
- **Main track:** accepts only video or image. The earliest element is forced to `startTime` 0 (`enforceMainTrackStart` in `apps/web/src/timeline/placement/main-track.ts`, plus the startTime rule in `apps/web/src/timeline/update-pipeline.ts`). The main track cannot be removed. Auto placement (`firstAvailable`) tries overlay tracks first, so to land on main use `{mode:"explicit", trackId: tracks.main.id}`.
- **Track compatibility:** `ELEMENT_TRACK_MAP` in `apps/web/src/timeline/placement/compatibility.ts`. video takes video and image, text takes text, audio takes audio, graphic takes sticker and graphic, effect takes effect.
- **Speed:** `retime.rate` is clamped to 0.01..5 (`clampRetimeRate`, `apps/web/src/retime/rate.ts`). It is a constant rate only (no ramps). `applyElementUpdate` recomputes `duration` when retime changes. Keyframes are not rescaled.
- **Transforms and styling live in `params`:** `transform.positionX/Y` (canvas px from the canvas centre, +y down), `transform.scaleX/Y` (1 means contain-fit), `transform.rotate` (degrees), `opacity` 0..1, `blendMode` (17 modes, not animatable), `volume` (dB, -60..20), `muted`.
  - Text keys: `content` (use `\n` for lines), `fontFamily`, `fontSize` (px = fontSize*canvasHeight/90; default 15; subtitles use 5), `color`, `textAlign`, `fontWeight` (normal or bold only), `fontStyle`, `textDecoration`, `letterSpacing`, `lineHeight`, and `background.enabled|color|cornerRadius|paddingX|paddingY|offsetX|offsetY`.
  - Schemas, with min, max, step and options, come from `elementParamRegistry` (`apps/web/src/params/registry.ts`). Coerce values with `coerceParamValue` (`apps/web/src/params/index.ts`).
- **Keyframes** are stored flat: `element.animations[path]`, holding a ScalarChannel, a DiscreteChannel, or a composite RGBA for colour.
  - Paths the renderer really animates: `ANIMATION_PROPERTY_PATHS` (verified: `transform.positionX/Y`, `transform.scaleX/Y`, `transform.rotate`, `opacity`, `volume`, `color`, `background.color|paddingX|paddingY|offsetX|offsetY|cornerRadius`), plus `params.<graphicParam>` and `effects.<effectId>.params.<key>`.
  - `resolveAnimationTarget` (`apps/web/src/timeline/animation-targets.ts`) also accepts fontSize, letterSpacing and lineHeight, but the renderer ignores them. Do not expose those paths.
  - A left trim does not shift keyframes, and a duration change drops the keys past the end.
- **Capabilities:**
  - Effects: blur only (`intensity` 0..100).
  - Graphics: 4 shapes.
  - Masks: 9 types (split, cinematic-bars, rectangle, ellipse, heart, diamond, star, text, freeform); the UI allows one per element; masks cannot be keyframed.
  - Not implemented: transitions, track reorder, slip/slide/roll, ripple-insert, speed ramps.
- **Scenes:** export and preview render the active scene (`RendererManager.exportProject` uses `scenes.getActiveScene()`), while project duration comes from the main scene. Tools should target the active scene and report which one it is.
- **Ripple** (`apps/web/src/ripple/diff.ts`) runs per track as a before/after diff and only closes gaps that were freed. A track with nothing in the cut range does not shift, so a "cut across all tracks" cannot rely on it.
- **Do not feed `docs/keyframes.md`, `docs/effects-renderer.md` or `docs/actions.md` to Claude.** They describe `animations.channels`, `src/lib/...` paths and `element.background`, none of which match the code.

---

## 3. The programmatic edit surface a bridge should call

### 3.1 Layers, best first

1. **Command classes from `@/commands`, grouped in one `BatchCommand` per tool call, run through `editor.command.execute`.** This gives deterministic ids (from getters), a single undo step, ripple and reactors applied consistently, and autosave for free.
2. **`TimelineManager` wrappers** (`apps/web/src/core/managers/timeline-manager.ts`). Each call creates its own history entry. Return values (verified):

   | Returns | Methods |
   |---|---|
   | ElementRef[] | `splitElements` (right-side refs), `duplicateElements` |
   | string | `addTrack` (trackId, but the reactor removes the track at once if it stays empty), `addClipEffect` (effectId) |
   | void | `insertElement`, `deleteElements`, `moveElements`, `updateElements`, `updateElementTrim`, `updateElementRetime` and the toggles |

   Use them only for single-step tools.
3. **`invokeAction`** (`apps/web/src/actions/registry.ts`): restricted allowlist only (3.4).
4. **`TracksSnapshotCommand({before, after})`**: for pure-function macros such as removing time ranges or applying a multi-track ripple. Validate the result yourself.

**Never** call `editor.timeline.updateTracks` directly from the bridge. It skips history, and 59 UI call sites already use it for preview.

### 3.2 Operation to command map (verified class names; constructor shapes quoted where read)

| Operation | Command | Constructor | Ids / notes |
|---|---|---|---|
| Insert element | `InsertElementCommand` | `{element: CreateTimelineElement, placement: {mode:"explicit",trackId} \| {mode:"auto",trackType?,insertIndex?}}` | `getElementId()` is stable from the constructor. `getTrackId()` returns `null` if placement failed. Explicit placement skips the overlap check. The first visual element sets canvas size and fps (cannot be undone) |
| New track | `AddTrackCommand` | `{type, index?}` | `getTrackId()` is available before execute. Must be batched with its inserts |
| Split | `SplitElementsCommand` | `{elements, splitTime, retainSide:"both"\|"left"\|"right"}` | `getRightSideElements()` after execute. New UUIDs on every execute and redo |
| Delete | `DeleteElementsCommand` | `{elements}` | Ripples if the global flag is on |
| Update / trim / speed / params / masks / hidden | `UpdateElementsCommand` | `{updates:[{trackId, elementId, patch: Partial<TimelineElement>}]}` | Goes through `applyElementUpdate`. Unknown refs are skipped silently. No overlap check. Params are shallow-merged |
| Move | `MoveElementCommand` | `{moves: PlannedElementMove[], createTracks?: PlannedTrackCreation[]}` | Throws on an invalid ref. No overlap check. Plan with `buildMoveGroup` and `resolveGroupMove` (`apps/web/src/timeline/group-move/`) |
| Duplicate | `DuplicateElementsCommand` | `{elements}` | `getDuplicatedElements()`. Copies go to a new top track at the same time |
| Clip effects | `AddClipEffectCommand` (`getEffectId()`), `UpdateClipEffectParamsCommand`, `ToggleClipEffectCommand`, `RemoveClipEffectCommand`, `ReorderClipEffectsCommand` | see `apps/web/src/commands/timeline/element/effects/` | |
| Keyframes | `UpsertKeyframeCommand({trackId, elementId, propertyPath, time, value, interpolation?, keyframeId?})`, `RemoveKeyframeCommand`, `RetimeKeyframeCommand`, `UpdateScalarKeyframeCurveCommand`, `UpsertEffectParamKeyframeCommand`, `RemoveEffectParamKeyframeCommand` | | `time` is element-local ticks. `interpolation` is "linear", "hold" or "bezier" |
| Masks | `UpdateElementsCommand` patch `{masks:[buildDefaultMaskInstance({maskType, elementSize})]}` (`apps/web/src/masks/index.ts`), `RemoveMaskCommand`, `ToggleMaskInvertedCommand`, freeform point commands | | |
| Tracks | `ToggleTrackMuteCommand`, `ToggleTrackVisibilityCommand`, `RemoveTrackCommand` | | |
| Source audio | `ToggleSourceAudioSeparationCommand` | | Check `canToggleSourceAudio` (`apps/web/src/timeline/audio-separation`) first |
| Bookmarks | `ToggleBookmarkCommand(time)`, `UpdateBookmarkCommand({time, updates:{note,color,duration}})`, `MoveBookmarkCommand`, `RemoveBookmarkCommand` | | Ranged bookmarks work as review markers |
| Scenes | `CreateSceneCommand` (`getSceneId()`), `RenameSceneCommand`, `DeleteSceneCommand`; switching is `editor.scenes.switchToScene({sceneId})` | | |
| Project settings | `UpdateProjectSettingsCommand(Partial<TProjectSettings>)` or `editor.project.updateSettings({settings, pushHistory})` | | Use it for 9:16 (1080x1920) |
| Media | `AddMediaAssetCommand({projectId, asset})` (`getAssetId()` before execute), `RemoveMediaAssetCommand` | | See 1.4 on nested entries |
| Paste | `PasteCommand`, or `editor.clipboard.paste({time})` | | |
| Anything else | `TracksSnapshotCommand({before, after})` | | |

**Element builders** (`apps/web/src/timeline/element-utils.ts`): `buildElementFromMedia({mediaId, mediaType, name, duration, startTime, buffer?})`, `buildTextElement({raw, startTime})`, `buildStickerElement`, `buildGraphicElement`, `buildEffectElement({effectType, startTime, duration?})`, `buildLibraryAudioElement`. Default duration for new elements: `DEFAULT_NEW_ELEMENT_DURATION` = 5 s (`apps/web/src/timeline/creation.ts`).

**Validation helpers**, which are pure and could also run server-side:
- `canPlaceTimeSpansOnTrack`, `resolveTrackPlacement`, `canElementGoOnTrack` (`apps/web/src/timeline/placement/`)
- `resolveGroupMove` (`apps/web/src/timeline/group-move/`)
- `computeGroupResize({members, side, deltaTime, fps})` (`apps/web/src/timeline/group-resize/compute-resize.ts`)
- `applyElementUpdate` (`apps/web/src/timeline/update-pipeline.ts`)
- `splitAnimationsAtTime` and the other helpers in `apps/web/src/animation/keyframes.ts`
- `getSourceTimeAtClipTime` / `getClipTimeAtSourceTime` (`apps/web/src/retime/resolve.ts`)

### 3.3 The transaction wrapper every mutating tool should use

New file `apps/web/src/claude/ai-edit.ts`:

```ts
export function runAiEdit({ editor, label, build, verify }: {
  editor: EditorCore; label: string;
  build: (tracks: SceneTracks) => Command[];
  verify?: (cmds: Command[]) => string | null;          // e.g. every InsertElementCommand.getTrackId() !== null
}) {
  if (!editor.project.getActiveOrNull() || editor.project.getIsLoading()) throw new BridgeError("NO_PROJECT");
  if (editor.timeline.isPreviewActive() || editor.playback.getIsScrubbing()) throw new BridgeError("USER_INTERACTING");
  if (editor.project.getExportState().isExporting) throw new BridgeError("EXPORTING");
  const before = editor.scenes.getActiveScene().tracks;
  const ripple = editor.command.isRippleEnabled;
  editor.command.isRippleEnabled = false;                 // safe: the sync effect only fires when the store value changes
  try {
    const cmds = build(before);
    editor.command.execute({ command: new BatchCommand(cmds) });
    const problem = verify?.(cmds);
    if (problem) { editor.command.undo(); throw new BridgeError("INVALID", problem); }
    return { label, cmds };
  } catch (e) {
    if (editor.scenes.getActiveScene().tracks !== before && !(e instanceof BridgeError)) editor.timeline.updateTracks(before); // half-applied batch, no history entry
    throw e;
  } finally { editor.command.isRippleEnabled = ripple; }
}
```

Then return a compact before/after diff plus the created ids, and `await editor.save.flush()` before reporting success.

Optional small core changes that make this cleaner, all acceptable in a private fork:
- `label?: string` on `Command`, and a labelled `AiEditCommand extends BatchCommand`.
- `CommandManager.subscribe()` plus `notify()` on execute, undo, redo and clear, so the chat panel can show "Annuler la derniere modif IA".
- `this.editor.command.clear()` in `ProjectManager.loadProject`.

### 3.4 Why not the actions layer, and what it is still good for

`invokeAction(action, args?, trigger?)` returns `void`, fires and forgets, and drops handler results. It silently does nothing when `EditorRuntimeBindings` is not mounted. All 30 handlers are bound in `useEditorActions()` (`apps/web/src/actions/use-editor-actions.ts`) through `useActionHandler`, whose `handlerRef` is refreshed in a `useEffect` after commit.

**Stale closures (verified):** `split`, `split-left`, `split-right`, `delete-selected`, `duplicate-selected`, `toggle-source-audio` and `toggle-elements-muted/visibility-selected` read `selectedElements` from `useElementSelection()` as of the last render. `delete-selected` mixes a fresh `editor.selection.getActiveSelectionKind()` with the stale `selectedElements`. So `setSelectedElements([B])` followed by `invokeAction("delete-selected")` in the same tick can delete A.

Safe allowlist for a generic `run_editor_action` tool (these handlers read the managers fresh): toggle-play, stop-playback, seek-forward/backward `{seconds}`, frame-step-forward/backward, jump-forward/backward, goto-start/end, copy-selected, paste-copied, select-all, toggle-bookmark, toggle-snapping, toggle-ripple-editing, undo, redo, remove-media-asset(s).

Recommended small refactor: move the handler bodies into pure `(editor, opts) => result` functions (for example `apps/web/src/actions/handlers.ts`) that read `editor.selection` and `useTimelineStore.getState()` at call time. This also fixes the keyboard path. Also export `hasActionHandler(action)` from `registry.ts`, and add `"agent"` to `TInvocationTrigger` (`apps/web/src/actions/types.ts`).

---

## 4. Media in and out

### 4.1 Import path today

Every entry point hands a `File[]` to `processMediaAssets({files, onProgress})` (`apps/web/src/media/processing.ts`). The entry points are the Assets panel (`MediaView.processFiles` in `apps/web/src/components/editor/panels/assets/views/assets.tsx`), a timeline drop (`DragDropController.executeFileDrop` in `apps/web/src/timeline/controllers/drag-drop-controller.ts`) and paste (`usePasteMedia` in `apps/web/src/media/use-paste-media.ts`).

`processMediaAssets` runs these steps:
1. MIME type detection (`getMediaTypeFromFile`). `file.type` must be set, otherwise the file is rejected as unsupported.
2. Quota check (`storageService.canStoreFile`: `navigator.storage.estimate()` minus a 50 MB reserve).
3. Object URL.
4. Probe: `readVideoFile({file})` in `apps/web/src/media/mediabunny.ts` uses mediabunny `Input` plus `BlobSource`. It reads duration, size, fps, hasAudio, codec and `canDecode`, and grabs a JPEG thumbnail at 1 s.

It returns `ProcessedMediaAsset = Omit<MediaAsset,"id">`. The result then goes to either `editor.media.addMediaAsset({projectId, asset})` (awaited, returns `MediaAsset | null`, cannot be undone) or `AddMediaAssetCommand` (can be undone; see `use-paste-media.ts` for the reference pattern `AddMediaAssetCommand + InsertElementCommand(buildElementFromMedia(...))` in one `BatchCommand`).

### 4.2 Getting a disk file into the tab (recommendation)

Phase 1, zero editor refactor:
1. The sidecar serves `GET /files?path=<abs>` with Content-Type, Content-Length and Range. It is restricted to allow-listed roots (for example `~/impulsion/videos`) and sends CORS for `http://localhost:3456` only.
2. The tab runs `res = await fetch(url)`, then `new File([await res.blob()], basename, {type})`, then `processMediaAssets`, then `runAiEdit([AddMediaAssetCommand, InsertElementCommand?])`.
3. The tab reports back `{assetId, duration, width, height, fps, hasAudio, canDecode}`.
4. The sidecar records `mediaId -> absolute path + sha1` in a per-project index (for example `~/.opencut-impulsion/<projectId>/media-index.json`). The Python tools need real paths; OPFS has none.

Costs: the bytes are copied into Chrome blob storage and then into OPFS. That is fine for reels. It is heavy for 10-15 GB DJI rushes.

Phase 2 options:
- Stream `res.body.pipeTo(opfsHandle.createWritable())`. This needs a new `OPFSAdapter.setFromStream` plus a metadata-only save in `StorageService`.
- Or zero-copy **linked media**: persist a File System Access directory handle on `~/impulsion/videos`, and add an additive `source: {kind:"linked", root, relPath}` field to `MediaAssetData` with a migration.
- Swapping every `BlobSource(file)` for mediabunny `UrlSource` (mediabunny 1.41.0 is installed) is the largest refactor and can wait.

Media imported through the UI (drag and drop) has no known path. For those assets the transcription tool uploads the OPFS `File`, or a 16 kHz mono extract, to the sidecar.

### 4.3 Exporting back to disk

- `editor.project.export({options})` returns `Promise<ExportResult>` (`apps/web/src/core/managers/project-manager.ts`). It drives `exportState`, which the UI progress bar reads. `getExportState()`, `cancelExport()` and `clearExportState()` exist. `editor.renderer.exportProject` does the work but does not update the UI state.
- **Verified types** (`apps/web/src/export/index.ts`): `ExportOptions {format:"mp4"|"webm"; quality:"low"|"medium"|"high"|"very_high"; fps?: FrameRate; includeAudio?: boolean}` and `ExportResult {success; buffer?: ArrayBuffer; error?; cancelled?}`. `ExportButton` (`apps/web/src/components/editor/export-button.tsx`) passes `fps: activeProject.settings.fps` (a FrameRate), then calls `downloadBuffer`.
- `SceneExporter` (`apps/web/src/services/renderer/scene-exporter.ts`) uses a mediabunny `Output` with `BufferTarget` (line 99) and a `CanvasSource` on the compositor canvas. Video is avc for mp4 or vp9 for webm; audio is aac (opus fallback). Resolution is always `canvasSize`. Frames are rendered on the main thread. Audio is mixed first by `createTimelineAudioBuffer` (it decodes whole sources; progress stays at 5% during this phase).
- Phase 1: the tab POSTs `result.buffer` to sidecar `/exports?name=`, which writes to `~/impulsion/videos/exports/<name>.mp4` and returns the path. Run it as a job (`start_export`, `export_status`).
- Phase 2, for long or 4K exports: a `target?: Target` option on `SceneExporter` using mediabunny `StreamTarget`, whose chunks `{type:"write", data, position}` are POSTed and written with positional `fs.write`. Also a `range?: {start,end}` option for draft clips. Size note: 4K high is about 22 Mbps, roughly 1.7 GB per 10 minutes, held in RAM with `BufferTarget`.

### 4.4 Grabbing frames for Claude's vision

- Existing: `RendererManager.createSnapshot()` is **private**. It renders the current playhead with `new CanvasRenderer({width, height, fps}).renderToCanvas({node: getRenderTree(), time, targetCanvas})` and calls `toBlob("image/png")`. `ProjectManager.updateThumbnailFromTimeline` is a variant that uses `buildScene`.
- Add a public `RendererManager.captureFrame({time, maxEdge = 1280, mime = "image/jpeg", quality = 0.85}): Promise<{base64, width, height, time}>`:
  1. `buildScene({tracks, mediaAssets, duration, canvasSize, background})`.
  2. `new CanvasRenderer`, then `renderToCanvas` into a target canvas sized to `maxEdge` (drawImage scales it), clamped to `timeline.getLastFrameTime()`.
  3. Encode immediately in the same task. On the WebGL fallback the drawing buffer is only readable during that task.
  4. `await loadFonts({families})` for the text elements first.
- **Required safety:** there is one compositor canvas (a thread_local in `rust/wasm/src/compositor.rs`) and one `videoCache`, shared by the preview, snapshots, thumbnails and export.
  - Add `runExclusive(fn)` as a render mutex.
  - Make `PreviewCanvas` (`apps/web/src/preview/components/index.tsx`) skip rendering while the mutex is held.
  - Add a `previewVersion` counter that resets `lastFrameRef` and `lastSceneRef`, so the preview redraws after a capture. Without it the preview keeps showing the captured frame.
- Also useful:
  - `capture_contact_sheet`: sorted times keep `VideoCache` on its forward iterator.
  - `capture_annotated_frame`: bounding boxes from `getVisibleElementsWithBounds` (`apps/web/src/preview/element-bounds.ts`).
  - `peek_media`: raw asset frames via mediabunny `CanvasSink({width: 480})` and `canvasesAtTimestamps`.
  - `get_media_thumbnail`: the stored `thumbnailUrl`.
- Rendering facts:
  - The GPU compositor is Rust/wgpu compiled to wasm (`opencut-wasm` 0.2.10, prebuilt). It uses WebGPU, with a WebGL2 fallback. There is no CPU fallback (only the degraded banner).
  - The only GPU effect shader is gaussian-blur.
  - No Rust toolchain is installed, so every extension must be TypeScript.
  - Playback and the preview loop run on rAF and stop in background tabs. Capture and export are promise chains and keep running.

---

## 5. Captions, transcription and text-based editing

### 5.1 What exists (verified)

- `transcriptionService.transcribe({audioData: Float32Array, language?, modelId?, onProgress?})` (`apps/web/src/services/transcription/service.ts`) runs a Web Worker (`worker.ts`) with a transformers.js `pipeline("automatic-speech-recognition", id, {dtype: "q4", device: "auto"})` and `return_timestamps: true`, 30 s chunks and 5 s stride. The output is **segment-level only**: `TranscriptionSegment {text, start, end}`.
- The Captions panel (`apps/web/src/subtitles/components/assets-view.tsx`) never passes `modelId`, so it always runs `DEFAULT_TRANSCRIPTION_MODEL = "whisper-small"`. Its steps:
  1. Transcribe the whole **timeline mix** with `extractTimelineAudio` (44.1 kHz WAV) and `decodeAudioToFloat32` (16 kHz mono).
  2. `buildCaptionChunks` (`apps/web/src/transcription/caption.ts`) splits the text into fixed 3-word chunks spread evenly across each segment (`caption-defaults.ts`: `DEFAULT_WORDS_PER_CAPTION`, `MIN_CAPTION_DURATION_SECONDS`).
  3. `insertCaptionChunksAsTextTrack({editor, captions})` (`apps/web/src/subtitles/insert.ts`) runs one `BatchCommand(AddTrackCommand text@0 + InsertElementCommand per cue)` and returns the trackId.
- The transcript is thrown away after insertion.
- `buildSubtitleTextElement` measures text with a DOM canvas, so it must run in the tab. It uses fontSize 5, wraps at 80% of the width and places the text at the bottom with a 5% margin.
- SRT and ASS import go through `parseSubtitleFile` (`apps/web/src/subtitles/parse.ts`). There is no exporter.
- Text rendering (`apps/web/src/services/renderer/nodes/text-node.ts`) draws one colour per element, with no stroke, no shadow and no per-word colour.

### 5.2 Plan

1. **Transcription backend.**
   - Add a warm Python worker managed by the sidecar. Spawn `/usr/local/bin/python3` with `SSL_CERT_FILE` set from certifi, speaking JSON lines over stdio.
   - It imports `transcribe_x` from `~/impulsion/montage-video/reel-remotion/plan.py` (WhisperX large-v3-turbo, CPU int8, wav2vec2 French alignment, `trim_ends` energy snapping) and `engine.apply_replacements`.
   - Cache results by content sha1. Stream progress to the chat panel.
   - Cost: roughly 0.3x realtime on CPU, so run it as a job.
   - Input: the absolute path from the media index, or the uploaded OPFS `File`.
2. **Data.** `TranscriptWord {id: "${mediaId}:${i}", text, start, end /* source seconds */, score?, speaker?}` and `Transcript {mediaId, language, model, aligned, words, segments, sourceHash, createdAt}`. Keep them in a new `TranscriptManager` (subscribe and notify like the other managers) registered in the `EditorCore` constructor. Persist them in a dedicated IndexedDB store keyed `${projectId}:${mediaId}` (the `savedSoundsAdapter` pattern). Also mirror them in the sidecar cache so Claude can read them without the tab.
3. **Projection.** For each main-track or audio element that has a `mediaId`, keep the words whose source span falls inside `[trimStart, trimStart + duration*rate]` and compute `tl = startTime + getClipTimeAtSourceTime(src - trimStart, retime)`. The projection stays correct after any cut.
4. **Text-based cut.** Resolve word ids to timeline ranges:
   - Pad them like `tighten` does: 0.12 s kept after a word, 0.10 s before the next.
   - Snap with `roundFrameTime` and merge overlapping ranges.
   - Pass them to a new pure `removeTimeRanges({tracks, ranges})` (`apps/web/src/ripple/remove-ranges.ts`). It reuses the `SplitElementsCommand` math and `splitAnimationsAtTime`, drops the middle pieces, and shifts **every** element after each range on overlay, main and audio tracks.
   - Apply it through `runAiEdit` with `TracksSnapshotCommand`, ripple pinned off.
   - Regenerate captions from the projected words afterwards instead of cutting the caption track (cut captions duplicate their text).
5. **Captions from words.** New `buildCaptionChunksFromWords({words, maxWords, maxChars, maxGapSeconds, breakOnPunctuation, minDuration})`, built on `engine.auto_cards` rules (split before French linking words, 1-3 words, text about 1 frame early). Its output goes to `insertCaptionChunksAsTextTrack`. A replace mode removes the old caption track in the same batch.
   - Real karaoke (per-word highlight, stroke) needs new text params and renderer work in `text-node.ts` and `apps/web/src/text/primitives.ts`, or one element per word.
   - Alternative: keep Remotion as the final reel renderer (section 10).
6. **Review flow.**
   - `find_take_mistakes` and `tighten_pauses` only **propose** ranges `[{s,e,why}]`.
   - `mark_ranges` shows them as ranged bookmarks (`ToggleBookmarkCommand` plus `UpdateBookmarkCommand`).
   - the user validates in chat, then `cut_ranges` applies them. Take cuts are never applied automatically.

Browser fallback: `transcriptionService` with `modelId: "whisper-large-v3-turbo"` and `language: "fr"`. Word timestamps in the browser would need `return_timestamps: "word"` and an ONNX export with `alignment_heads`. Not verified.

---

## 6. What to strip or stub for a local-only, single-user build

### 6.1 Order matters

Relax `apps/web/src/env/web.ts` **first**. Today it runs `webEnvSchema.parse(process.env)` at import time, and `apps/web/src/app/layout.tsx` imports `webEnv`, so removing a variable before relaxing the schema breaks every page. New schema: `NODE_ENV`, `NEXT_PUBLIC_SITE_URL` (default `http://localhost:3456`), and optional `FREESOUND_API_KEY`, `FREESOUND_CLIENT_ID` and `CLAUDE_*`, all `.optional()`.

### 6.2 Remove or stub

| Item | Files | Action |
|---|---|---|
| better-auth + Postgres (unused by the UI) | `apps/web/src/auth/server.ts`, `apps/web/src/auth/client.ts` (imported nowhere), `apps/web/src/app/api/auth/[...all]`, `apps/web/src/db/*`, `apps/web/drizzle.config.ts` (points at a wrong schema path), migrations, `db:*` scripts | Delete |
| Upstash rate limit (throws without Redis, so `/api/sounds/search` and `/api/feedback` return 500) | `apps/web/src/auth/rate-limit.ts` | Delete, or turn into a no-op |
| Feedback | `apps/web/src/app/api/feedback`, `apps/web/src/feedback/*`, `FeedbackPopover` in `apps/web/src/components/editor/editor-header.tsx` | Delete. The header slot becomes the Claude toggle |
| Freesound | `apps/web/src/app/api/sounds/search/route.ts`, `apps/web/src/sounds/*` | Keep, but make it optional (503 "not configured" without a key, no rate limit) |
| botid (monkeypatches `window.fetch`, loads a Vercel challenge) | `withBotId` in `apps/web/next.config.ts`, `<BotIdClient>` in `apps/web/src/app/layout.tsx` | Delete before adding bridge traffic |
| Telemetry | Databuddy `<Script>` and react-scan from unpkg in `apps/web/src/app/layout.tsx`; Next CLI telemetry | Delete; set `NEXT_TELEMETRY_DISABLED=1` |
| Content collections / changelog (points at `src/lib/changelog/entries`, so the list is always empty) | `apps/web/content-collections.ts`, `withContentCollections`, `apps/web/src/changelog/*`, `ChangelogNotification` in the editor and projects pages and layout, tsconfig alias | Delete together, otherwise the build breaks |
| Marble CMS (falls back to OpenCut's real workspace key when unset) | `apps/web/src/blog/*` | Delete with the marketing pages |
| Marketing pages | `apps/web/src/app/{blog,brand,changelog,contributors,privacy,roadmap,sponsors,terms}`, `rss.xml`, `sitemap.ts`, `robots.ts`, `base-page.tsx`, header, footer, landing and sponsor components | Delete. `apps/web/src/app/page.tsx` becomes `redirect("/projects")` |
| Cloudflare / OpenNext | `open-next.config.ts`, `wrangler.jsonc`, `preview`/`deploy` scripts, `@opennextjs/cloudflare`, wrangler | Delete. The Agent SDK must never be deployed (subscription terms) |
| Unused | `apps/web/src/components/storage-provider.tsx`, `apps/web/src/commands/preview-tracker.ts` | Delete |
| Branding and copy | `apps/web/src/site/brand.ts`, Onboarding (Discord links, "Welcome to OpenCut Beta"), DegradedRendererBanner | Rebrand; French UI per the Impulsion convention |

Keep the outbound calls that are features: Google Fonts CSS (`apps/web/src/fonts/google-fonts.ts`), Hugging Face models (only for the browser Whisper fallback), and cdn.brandfetch.io guide icons. Vendor them later if offline use matters. Also accepted: in `next dev` only, Next 16.1 fetches `registry.npmjs.org` for its "outdated" indicator (`hot-reloader-shared-utils.js` `getVersionInfo`, no env switch); `next start` does not. The shell font (Inter) is vendored in `apps/web/src/fonts/inter/` and loaded with `next/font/local`, and the root turbo scripts set `TURBO_TELEMETRY_DISABLED=1` and `--no-update-notifier`.

Bind locally. Today the process listens on `*:3456` (all interfaces, verified with lsof). Use `next dev --turbopack -H localhost -p 3456`. Keep the browser URL exactly `http://localhost:3456`: every project lives under that origin, and switching to `127.0.0.1` or another port "loses" them. Add `apps/web/src/proxy.ts` (the Next 16 name for middleware) only if API routes remain.

### 6.3 Upstream bugs to fix in the first commit (all verified)

- **Migration runner does nothing.** `apps/web/src/services/storage/migrations/runner.ts:41-45` and `:98`, and `v1-to-v2.ts:124-137, 160-164`, still use the positional `new IndexedDBAdapter(db, store, 1)` and `set(key, value)`. The runner opens an IndexedDB database named "undefined" and migrates nothing. These are also TS2554 errors that fail `next build`.
- **fps and hasAudio not persisted.** `StorageService.saveMediaAsset` (~297) and `loadMediaAsset` (~370) drop them, so after a reload a silent video reports audio.
- **fps rounded.** `apps/web/src/media/processing.ts:141` applies `Math.round(fps)`, so 29.97 becomes 30 and NTSC rates are never reached.
- **AZERTY shortcuts.** `getPressedKey` (`apps/web/src/actions/keybindings-store.ts:234`) maps letters by `ev.code` (physical QWERTY position). On the user's French layout, Cmd+Z does not trigger undo, and the key that does trigger undo is the one Chrome uses for Cmd+W (close tab). Cmd+A has the same problem with Cmd+Q. Prefer `ev.key` for single a-z letters.
- **Build blockers.** `apps/web/src/actions/keybindings/persistence.ts` imports `isShortcutKey` and `isActionWithOptionalArgs`, which exist nowhere. `apps/web/src/stickers/providers/index.ts:22` has a TS2554.
- **History survives project switches.** `CommandManager.clear()` is never called; add it to `loadProject`.

---

## 7. Where the Claude chat panel goes

**Recommended: a dedicated collapsible fourth column** in `EditorLayout` (`apps/web/src/app/editor/[project_id]/page.tsx`).
- Inside the horizontal `ResizablePanelGroup`, after `PropertiesPanel`, add `<ResizableHandle withHandle /><ResizablePanel id="claude" order={4} collapsible collapsedSize={0} defaultSize={panels.claude} minSize={15} maxSize={40}><ClaudeChatPanel /></ResizablePanel>`.
- Give the existing three panels `id` and `order` (react-resizable-panels 2.1.9 needs them for collapsible panels).
- Extend `onLayout` with `setPanel({panel: "claude", size: sizes[3]})`.
- Add `claude` to `PanelSizes` in `apps/web/src/editor/panel-store.ts`, bump the persist version from 2 to 3 and handle it in `migrate`.
- Rebalance `PANEL_CONFIG.panels` in `apps/web/src/panels/layout.ts`, for example tools 20 / preview 45 / properties 20 / claude 15.
- Toggle it through an `ImperativePanelHandle` ref (`collapse()`/`expand()`) held in a small store. The button replaces `FeedbackPopover` in `EditorHeader` (`apps/web/src/components/editor/editor-header.tsx`).
- New files: `apps/web/src/claude/components/chat-panel.tsx`, and `apps/web/src/claude/chat-store.ts` (zustand, not persisted while streaming; session id per project in localStorage).

Why not a Sheet, Dialog or Popover: any of them increments `overlayDepth` (`apps/web/src/components/ui/use-overlay-open-change.ts`), which turns off every editor shortcut while it is open. A docked panel keeps shortcuts working. The chat textarea is already ignored by the keybinding and paste listeners (`isTypableDOMElement`).

Fallback option: a `claude` tab in the left Assets panel. Add it to `TAB_KEYS`/`tabs` in `apps/web/src/components/editor/panels/assets/assets-panel-store.tsx` (icon `AiChat02Icon` from `@hugeicons/core-free-icons`) and `viewMap` in `apps/web/src/components/editor/panels/assets/index.tsx`, built on `PanelView` (`views/base-panel.tsx`). The diff is smaller, but it hides Media while chatting, and the view unmounts on tab switch.

Panel UX mapping from `SDKMessage`:
- `stream_event` `text_delta`: streaming text.
- `content_block_start` `tool_use`: a status chip ("Claude coupe...").
- `user` `tool_result` with an image: a frame thumbnail.
- `rate_limit_event`: a quota badge.
- `result`: end of turn, with a session id to `resume` next time.
- Plus a Stop button (`q.interrupt()`) and an "Annuler l'edit IA" button (`editor.command.undo()`).

---

## 8. Claude integration mechanics

### 8.1 Sidecar `apps/bridge`

- Node 22 (`~/.local/bin/node` v22.23.2) running `tsx`, bound to `127.0.0.1:3457`.
- Dependencies: `@modelcontextprotocol/sdk@1.30.x` (stay on v1: the Agent SDK has a peer dependency on `^1.29`, and v2 renamed the API), `@anthropic-ai/claude-agent-sdk@0.3.x` (0.3.282 verified in the scratchpad), `ws@8`, `zod@4`, express via `createMcpExpressApp({host: "127.0.0.1"})` from `@modelcontextprotocol/sdk/server/express.js` (this turns on DNS-rebinding protection).
- Install with optional dependencies omitted and set `pathToClaudeCodeExecutable: "~/.local/bin/claude"` (CLI 2.1.280). This avoids the bundled 222 MB binary and keeps one Claude Code version.
- Start it next to Next (for example a root script `dev:impulsion` using `concurrently`).
- Why a separate process: Next route handlers cannot accept WebSocket upgrades, HMR resets module state, and Turbopack breaks the SDK's binary resolution.

### 8.2 Tab to hub protocol (one WebSocket, `ws://127.0.0.1:3457/editor`)

- The server passes `verifyClient: ({origin}) => origin === "http://localhost:3456"`. This check is essential: WebSockets are not covered by CORS, so any website could otherwise connect. A per-boot token (served to the page via `/token` with CORS) adds defense in depth.
- On connect the tab sends `{type:"hello", tabId, path, projectId|null, fps, canvasSize}`. The latest tab wins. Other tabs are told they are passive, and the chat panel shows "Editeur pilote dans un autre onglet".
- RPC: the hub sends `{type:"rpc", id, method, params}` and the tab answers `{type:"rpc-result", id, ok, result|error:{code,message}}`. Every call carries `projectId`, which is checked. `hub.call(method, params, {timeoutMs})` rejects with `EDITOR_NOT_CONNECTED` if no tab is connected.
- Events from the tab: `{type:"event", name:"state-changed", version}`, fed by `timeline.subscribe` and a registered reactor, so manual edits invalidate Claude's cached view.
- Chat channel on the same socket: `{type:"chat.send", sessionId?, text}` and `{type:"chat.event", message: SDKMessage}`. This avoids a second origin surface.
- Client mount: a `<ClaudeBridge/>` client component in `apps/web/src/app/layout.tsx`, so it survives client navigation between `/projects` and `/editor/<id>`.
  - Editor tools check `project.getActiveOrNull()`, `!project.getIsLoading()` and `!media.isLoadingMedia()`.
  - Mounting inside `EditorRuntimeBindings` also works, but then project-level tools vanish on `/projects`.
  - The effect cleanup must close the socket (`reactStrictMode: true` double-mounts in dev), and handlers must re-resolve `EditorCore.getInstance()` on every call (HMR).
- Payloads: frames as base64 JPEG inside JSON. Large binaries (exports, uploads for transcription) go over HTTP `/exports` and `/upload`, never over the socket.

### 8.3 MCP for Claude Code (the CLI)

- Transport: stateful Streamable HTTP at `/mcp`. Per session: `new StreamableHTTPServerTransport({sessionIdGenerator: randomUUID, onsessioninitialized})`, `new McpServer({name:"opencut", version}, {instructions: EDITOR_RULES})`, `registerEditorTools(server, hub)`, `server.connect(transport)`. The precedent is `~/impulsion/mcp-impulsion/src/lib/mcp/server.ts`.
- Why not stdio: every CLI session would spawn its own server, and they would fight over the port and the tab. The user runs parallel sessions.
- Registration (user scope is per profile, so do both):

  ```
  claude mcp add -s user -t http opencut http://127.0.0.1:3457/mcp
  CLAUDE_CONFIG_DIR=~/.claude-b claude mcp add -s user -t http opencut http://127.0.0.1:3457/mcp
  ```

  Alternative: a committed `.mcp.json` at the repo root with `{"mcpServers":{"opencut":{"type":"http","url":"http://127.0.0.1:3457/mcp","alwaysLoad":true}}}`. Both profiles see it, but only when cwd is inside opencut.
- About 13 user MCP servers are loaded, so set `_meta: {"anthropic/alwaysLoad": true}` on the core tools to avoid tool-search deferral. Keep the tool count small by preferring batch tools (`apply_edit_plan`).
- `EDITOR_RULES` (server instructions): units are seconds; always call `get_editor_state` first and re-read after undo or redo (split and duplicate ids change); cuts are proposed before they are applied; the taste defaults from section 10.

### 8.4 In-app chat on the Max subscription (Agent SDK)

```ts
query({ prompt: pushQueue /* AsyncIterable<SDKUserMessage>, one long-lived query per chat session */, options: {
  pathToClaudeCodeExecutable: "~/.local/bin/claude",
  cwd: "~/impulsion/opencut",
  env: { ...envWithout("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"), CLAUDE_CONFIG_DIR: profileDir }, // env REPLACES process.env
  model: "claude-opus-5",                       // see 8.6
  thinking: { type: "adaptive", display: "summarized" }, effort: "high",
  mcpServers: { opencut: sdkServer /* createSdkMcpServer({ name: "opencut", instructions: EDITOR_RULES, tools: [] }), tools registered on .instance */ },
  strictMcpConfig: true, settingSources: [], tools: [], allowedTools: ["mcp__opencut"],
  permissionMode: "default", canUseTool: askInPanelForDestructive,   // or "dontAsk" for a fully trusted toolset
  includePartialMessages: true, resume: savedSessionId,
  systemPrompt: { type: "preset", preset: "claude_code", append: CHAT_SYSTEM_PROMPT_APPEND /* = EDITOR_PROMPT_FR */ },
}})
```

- **Auth:** the spawned binary resolves credentials the way the CLI does: `ANTHROPIC_API_KEY`, then `apiKeySource` helpers, then the claude.ai OAuth login in the keychain for `$CLAUDE_CONFIG_DIR`. A smoke test in the scratchpad (`sdktest/test.mjs`) got `system/init` with `apiKeySource: "none"`, meaning the subscription was used. A `[image, text]` MCP tool result reached the model, and `resume` worked. **Strip the API key env vars**, and warn in the UI whenever `apiKeySource !== "none"`.
- **Profiles:** A (`~/.claude`) and B (`~/.claude-b`, optional second account) can both be logged in. Offer a switch, since chat usage draws on the same quota as daily Claude Code work.
- **Tool registry:** the definitions live in `packages/claude-tools` and are registered twice with `server.registerTool(tool.name, toMcpToolConfig(tool), handler)`: on the HTTP `McpServer` for the CLI, and on `createSdkMcpServer({name, instructions: EDITOR_RULES, tools: []}).instance` for the chat. Never pass `input.shape` or use the SDK's `tool()` helper (shape only): that drops the strict top-level schema and silently strips misspelled keys. Both handlers call `hub.call`. In Claude Code the tools appear as `mcp__opencut__<name>`.
- **Policy:** this is a local, single-user tool driving the user's own Claude Code login. Never deploy it on a server and never share one running instance between people: everyone installs their own copy and signs in with their own account.

### 8.5 Images

A tool returns `{content: [{type:"image", data: <base64>, mimeType: "image/jpeg"}, {type:"text", text: "frame @12.400s 1280x720"}]}`.
- Default: JPEG at a 1280 px long edge (about 1.2k tokens). Go up to 2576 px only on request.
- Use contact sheets rather than many separate images, because of `MAX_MCP_OUTPUT_TOKENS`.

### 8.6 Models (current IDs)

- Default for the chat: `claude-opus-5`, pinned explicitly with adaptive thinking.
- the user may choose `claude-sonnet-5` for faster, cheaper chat turns (his call, not a default), or `claude-haiku-4-5` for bulk sub-tasks.
- `claude-fable-5-1` is the most capable model but likely draws on usage credits.
- `claude-opus-5-5` is launching; use it only when named. It is the CLI default in this session, so omitting `model` in the SDK would inherit it.

### 8.7 Long jobs and timeouts

Transcription, export, Remotion renders and person cutouts outlast MCP tool timeouts (progress notifications do not extend them). Use `start_*` tools that return `{jobId}`, plus `job_status {jobId}` returning `{progress, result?}`. The sidecar keeps the job table and streams progress to the chat.

---

## 9. Candidate agent tool catalogue (deduplicated)

Every tool name below is an MCP tool. **Tab** means the handler runs in the browser through `hub.call`. **Sidecar** means it runs in Node or Python. Every mutating Tab tool goes through `runAiEdit` (one `BatchCommand`, one Cmd+Z, ripple pinned off), then `editor.save.flush()`.

### 9.1 Read and inspect (Tab, read-only)

| Tool | Returns | Calls |
|---|---|---|
| `get_editor_state` | Project settings, active scene id and list, tracks in display order with element summaries (seconds plus ids, no `buffer`), media summary, playhead, selection, `isPlaying`, `canUndo`/`canRedo`, ripple and snapping flags, preview/export busy flags | `project.getActive()`, `scenes.getScenes()`/`getActiveScene().tracks`, `media.getAssets()`, `playback.getCurrentTime()`, `selection.getSnapshot()`, `command.canUndo()/canRedo()`, `useTimelineStore.getState()`, `timeline.getTotalDuration()`, `mediaTimeToSeconds` |
| `get_element` | Full params, keyframes, effects, masks, retime, and the applicable param schema | `timeline.getElementsWithTracks({elements})`, `getElementParams` (`apps/web/src/params/registry.ts`), `getElementKeyframes` (`apps/web/src/animation/keyframe-query.ts`), `effectsRegistry`, `getGraphicDefinition`, `masksRegistry` |
| `list_capabilities` | Element kinds, track compatibility, effects, graphics, masks, blend modes, animatable paths and ranges | `elementParamRegistry.getAll()`, `effectsRegistry.getAll()`, `graphicsRegistry.getAll()`, `getMaskDefinitionsForMenu()`, `ELEMENT_TRACK_MAP`, `ANIMATION_PROPERTY_PATHS` |
| `list_media` | id, name, type, duration, width, height, fps, hasAudio, size, disk path (from the sidecar index) | `media.getAssets()` plus the sidecar media index |
| `list_projects` | id, name, duration, updatedAt | `project.loadAllProjects()` if not initialized, then `project.getSavedProjects()` |
| `get_render_info` | canvas, fps, duration, degraded GPU flag, cache stats | `project.getActive().settings`, `renderer.isDegraded`, `isGpuAvailable()` (`apps/web/src/services/renderer/gpu-renderer.ts`) |

### 9.2 Vision (Tab)

| Tool | Calls |
|---|---|
| `capture_frame {time?, maxEdge?}` | `playback.pause()`, `loadFonts`, new `renderer.captureFrame` (4.4) inside `runExclusive`, then bump `previewVersion` |
| `capture_contact_sheet {start,end,count \| times[]}` | Sorted `captureFrame` calls into a grid canvas with `formatTimecode` labels |
| `capture_annotated_frame {time}` | `captureFrame` plus `getVisibleElementsWithBounds({tracks, currentTime, canvasSize, mediaAssets})`; returns the image and JSON bounds |
| `peek_media {mediaId, times[]}` | mediabunny `Input(BlobSource(asset.file))`, `CanvasSink({width:480}).canvasesAtTimestamps` |

### 9.3 Edit (Tab, one undo step each)

| Tool | Ops and calls |
|---|---|
| `apply_edit_plan {ops[]}` | The main mutating tool. `ops` is a discriminated union, each op mapped to the command in 3.2: `insert_media` (`buildElementFromMedia` + `InsertElementCommand`, using `tracks.main.id` for main), `add_text` (`buildTextElement`), `add_graphic` / `add_sticker` / `add_effect_layer`, `split` (`SplitElementsCommand`), `trim` (`computeGroupResize`, then `UpdateElementsCommand`), `move` (`resolveGroupMove`, then `MoveElementCommand`), `delete`, `update_element` (`coerceParamValue`, then `UpdateElementsCommand`), `set_speed` (`buildConstantRetime`, `apps/web/src/retime/presets.ts`), `keyframe` (`UpsertKeyframeCommand` and relatives), `effect` (`AddClipEffectCommand` and relatives), `mask`, `bookmark`, `project_settings` (`UpdateProjectSettingsCommand`), `new_track` (`AddTrackCommand`, same batch). Returns the created ids |
| `cut_ranges {ranges[] \| wordIds[], padding?, dry_run?}` | Transcript or silence cuts across all tracks: `removeTimeRanges` (new, 5.2), then `TracksSnapshotCommand`. Returns seconds removed and the new duration |
| `add_captions {source:"transcript"\|"cues", preset, replaceTrackId?}` | `buildCaptionChunksFromWords` (new) or cues passed in, then `insertCaptionChunksAsTextTrack` (plus `RemoveTrackCommand` in the same batch when replacing) |
| `style_track {trackId, params}` | `loadFonts({families})`, then one `UpdateElementsCommand` over every element of the track, validated against `textElementParams` |
| `mark_ranges {ranges:[{s,e,note,color}]}` | `ToggleBookmarkCommand` plus `UpdateBookmarkCommand({time, updates:{note,color,duration}})` |
| `replace_tracks {tracks}` (escape hatch, off by default) | `TracksSnapshotCommand({before, after})` |

### 9.4 History, playback, UI (Tab)

| Tool | Calls |
|---|---|
| `undo` / `redo` | `command.undo()` / `redo()`; returns `canUndo()`/`canRedo()` |
| `seek {time}`, `play`, `pause`, `select {elements[]}` | `playback.seek({time: mediaTimeFromSeconds})`, `play()`, `pause()`, `selection.setSelectedElements({elements})` |
| `run_editor_action {action, args?}` | Safe allowlist from 3.4 only, `hasActionHandler` (new) guard, `invokeAction(action, args, "agent")` |
| `set_editor_modes {ripple?, snapping?}` | `useTimelineStore.getState().toggleRippleEditing()` / `toggleSnapping()` |
| `focus_ui {tab?, revealMediaId?}` | `useAssetsPanelStore.getState().setActiveTab()` / `requestRevealMedia()` |

### 9.5 Project and media lifecycle

| Tool | Where | Calls |
|---|---|---|
| `create_project {name, preset?}` | Tab | `project.createNewProject({name})`, then `location.assign("/editor/"+id)`, then optionally `updateSettings` to 1080x1920 |
| `open_project {id}` | Tab | Validate against `getSavedProjects()`, `await project.prepareExit(); project.closeProject()`, navigate, wait for `getActiveOrNull()?.metadata.id === id && !getIsLoading() && !media.isLoadingMedia()` |
| `rename_project` | Tab | `project.renameProject({id, name})` |
| `import_media {path, place?: {time, track?}}` | Sidecar + Tab | Sidecar `/files`; tab `fetch`, `new File`, `processMediaAssets`, `runAiEdit([AddMediaAssetCommand, InsertElementCommand?])`; sidecar records mediaId to path |
| `remove_media {ids}` | Tab | `media.removeMediaAssets({projectId, ids})` (may leave 2 undo entries) |
| `save_project` | Tab | `await save.flush()`; returns `getIsDirty()` |
| `storage_status` | Tab | `readStorageQuotaStatus()` (`apps/web/src/services/storage/quota.ts`), `navigator.storage.persisted()` |
| `export_project_json` | Tab + Sidecar | New `StorageService.exportProjectJson`, POSTed to the sidecar for backup and diffs |

### 9.6 Output (Tab + Sidecar, jobs)

| Tool | Calls |
|---|---|
| `start_export {format, quality, includeAudio, name}` then `job_status` / `cancel_export` | `project.export({options:{format, quality, fps: settings.fps, includeAudio}})`, progress from `getExportState()`, POST `buffer` to `/exports`, `clearExportState()`; `cancelExport()` |
| `render_draft_clip {start, end}` | Needs the new `range` option on `SceneExporter`, quality low |

### 9.7 Local AI jobs (Sidecar, Python worker; see section 10)

| Tool | Calls |
|---|---|
| `transcribe_media {mediaId, mode:"accurate"\|"fast"}` | `plan.transcribe_x` (WhisperX) or `engine.transcribe` (faster-whisper), `engine.apply_replacements`, then the tab's `TranscriptManager.set` |
| `get_transcript {window?, speaker?}` / `search_transcript {query}` | Tab projection (5.2 step 3); compact lines such as `#m1:412 [12:03.4] S: ...` |
| `tighten_pauses {preset:"reel"\|"podcast", dry_run}` | `plan.tighten(words, base, dur, gap_cut=0.35)` or the podcast variant (pauses over 2 s shrunk to 0.9 s), then `cut_ranges` |
| `find_take_mistakes` | The flags section of `analyse.py` (OFF_PAT asides, Jaccard retakes, stutters), then `mark_ranges`. Proposes only |
| `sync_cameras_by_audio`, `attribute_speakers_by_mic`, `plan_multicam_autopod` | New sync script plus a parametrised `analyse.py` and `plan_multicam.py`; results placed through `apply_edit_plan` (two masked video tracks) |
| `face_zoom_punch_ins`, `place_sfx`, `broll_behind_person`, `voice_master_and_qa`, `render_with_remotion_engine`, `apply_review_feedback` | Section 10 |

---

## 10. Reusable Impulsion tooling to wrap

Environment facts:
- `/usr/local/bin/python3` (3.11.2) is the only working environment: faster-whisper 1.2.1, whisperx, torch 2.8, pyannote 4.0.7, cv2, numpy, scipy. WhisperX needs `SSL_CERT_FILE=$(python3 -m certifi)`. Do not use Homebrew python3 or `/opt/homebrew/bin/whisper` (broken).
- Models are cached: faster-whisper large-v3-turbo, small and medium; the wav2vec2 voxpopuli French aligner.
- ffmpeg 7.1.1 at `/opt/homebrew/bin` (libass, loudnorm, videotoolbox).
- Node 22 at `~/.local/bin/node`; Remotion 4.0.522 in `reel-remotion/node_modules`.
- Run every Python tool as a subprocess, never in-process: cv2 and av ship duplicate libavdevice.

| Capability | Code (verified to exist) | Entry | Wrap as |
|---|---|---|---|
| Word timestamps, WhisperX with French alignment and energy-trimmed ends | `~/impulsion/montage-video/reel-remotion/plan.py` | `transcribe_x(src, work, language="fr")` returns `[{w,s,e}]` in source seconds, cached in `work/words_x.json` | `transcribe_media` (accurate) |
| Faster, rougher words | `~/impulsion/montage-video/reel-facecam/engine.py` | `transcribe(src, work, language)`, `apply_replacements(words, pairs)`, `norm(s)` | `transcribe_media` (fast), transcript corrections |
| Pause tightening | plan.py | `tighten(words, base, dur, gap_cut=0.35)` returns keep ranges; the podcast variant is in `plan_multicam.py` lines 39-60 | `tighten_pauses` |
| Source to output mapping | engine.py | `build_map(keep)`, `to_out(t, mapping)`, `map_words(words, mapping)` | Only needed for Remotion export; OpenCut projects through element trims instead |
| Caption cards (French linking-word rules) | engine.py | `auto_cards(words, keywords, max_words=3, max_chars=22, pause=0.28, phrase_pause=0.45)`, `layout_cards(cards, mapping_end, max_lines=3)` | `buildCaptionChunksFromWords` port, `add_captions` |
| Faces (OpenCV Haar, cached `faces.json`) | engine.py | `detect_faces(src, mapping, work, crop_box, size=(540,960))`; punch = `min(1.24, max(1.06, 1.22-(face_h-0.15)*0.7))` | `face_zoom_punch_ins`, which writes `transform.scaleX/Y` keyframes plus compensating `transform.positionX/Y` (there is no transform-origin) |
| SFX with the peak landing 2 frames early; BANNED list | plan.py `sfx_at(kind, event_ms)`, `sfx/catalog.json` (100 CC0 sounds) | Drop or re-measure the 45 ms Remotion latency offset | `place_sfx`: `/files` import, then audio elements on an "sfx" track with `volume` in dB |
| Person cutout (Apple Vision) | `~/impulsion/montage-video/reel-remotion/personmask` | `personmask <in_dir> <out_dir> [accurate\|balanced\|fast]`; `plan.person_frames(...)`; `plan.fetch_broll(...)` | `broll_behind_person` (heavy: about 110 MB of PNG per second, purge afterwards) |
| Full reel render (karaoke, zoom, overlays) | plan.py `run(cfg, mode)`, `render.mjs` (`node render.mjs plan.json out.mp4 [--crf 17] [--still ms]`) | Remotion composition typed by `src/types.ts` (zod `ReelPropsSchema`) | `render_with_remotion_engine`: editor state to CONFIG, render, re-import the MP4 |
| Podcast: speakers from mic ratio, retakes, asides, stutters | `~/impulsion/videos/podcast-imp-ep1/work/analyse.py` | cwd-relative, OFF=1.124 hardcoded | Parametrise, then `attribute_speakers_by_mic` and `find_take_mistakes` |
| Podcast autopod camera plan | `.../work/plan_multicam.py` (drop the VectCut `build` part) | Rules: MIN_SHOT 2.2 s, D_MIN_SOLO 1.6 s, SHORT_TURN 4 s, INTRO/OUTRO 10 s, SNAP_CUT 1.2 s, ZOOM_CUT 1.08 | `plan_multicam_autopod`: two video tracks, 2-shot via 50% `rectangle`/`split` masks |
| Camera sync | none committed (the offset was computed ad hoc) | New: 16 kHz envelopes plus `scipy.signal.correlate` on 3 windows | `sync_cameras_by_audio` |
| Voice chain and QA | plan.py / `regles-montage.md` | highpass 80 Hz, `loudnorm I=-14 TP=-1.5 LRA=9`, alimiter; ebur128, blackdetect, tile contact sheet, re-transcribe and diff | `voice_master_and_qa` (runs on the exported file) |
| Timecoded review | `~/impulsion/outils/review-video/server.mjs` (port 4602) | `/api/retours` | `apply_review_feedback`; later replaced by OpenCut ranged bookmarks |
| Editing rules and taste | `~/.claude/skills/reel-facecam/SKILL.md`, `reference/regles-montage.md`, `reference/grammaire-hook.md` | | Load them into `EDITOR_PROMPT_FR` and the MCP `instructions` |

Taste defaults the tools must encode:
- Organic look: Figtree, all white, no pill, no yellow ("creator" look only on request).
- Hook title: 32 characters or less, white, at 12% height, first shot only.
- One keyword per sentence (weight 800 vs 600, x1.12). No punctuation on cards, no text on the face, no em dash.
- SFX quiet, BANNED impact/hit family refused, meme sounds never in ads.
- No shot under 2.2 s, no filler 2-shot during a monologue.
- Take cuts are proposal-only.

The CapCut MCP (`mcp__capcut__*`) is superseded: no absolute placement, no transforms or masks, URL-only inputs, write-only drafts, and it copied 14-15 GB of rushes.

---

## 11. Risks and open questions

### 11.1 Risks (most severe first)

| Risk | Mitigation |
|---|---|
| All data is bound to origin `http://localhost:3456` in one Chrome profile; Node cannot read IndexedDB or OPFS | Pin host and port; JSON mirror and backups via the sidecar; `navigator.storage.persist()` (auto-requested by `useStoragePersistence`) |
| The dev server listens on all interfaces and the WebSocket is reachable from any website | `-H localhost`, WS Origin check, loopback-only sidecar, allow-listed `/files`, optional per-boot token |
| An API key in the environment silently bills the API instead of Max | Strip `ANTHROPIC_API_KEY`/`AUTH_TOKEN` in `options.env`; alert when `apiKeySource !== "none"` |
| Shared compositor canvas and `videoCache`: a capture or export during a preview render gets wrong frames; the preview gets stuck on the captured frame | `runExclusive` mutex, `previewVersion` invalidation, refuse edits while exporting |
| Silent command failures still recorded in history; `BatchCommand` not atomic; nested entries from media commands | `runAiEdit` (snapshot, verify getters, undo on failure); build commands directly, avoid manager wrappers inside batches |
| Ripple is a global user toggle that post-processes every command and works per track only | Pin it off during AI edits; explicit multi-track `removeTimeRanges` |
| Time-unit bugs: seconds, ticks, element-local keyframes, source vs timeline time, 30 vs 60 fps sources | Seconds at the tool boundary, a single conversion point, frame snapping, end = start + duration |
| Overlap and trim checks live in UI planners, not in commands | Call `canPlaceTimeSpansOnTrack`, `resolveGroupMove`, `computeGroupResize` before building commands |
| Large media: double copy on import; `waveform-cache/service.ts:64` runs `arrayBuffer()` on whole files; the export audio mix decodes whole sources; `BufferTarget` holds the full output in RAM | Phase 2 streaming or linked media and `StreamTarget`; proxies for 4K HEVC (`canDecode` false breaks preview and export) |
| Long jobs exceed MCP timeouts; WhisperX runs on CPU | Job pattern, content-hash caching, warm Python worker |
| Quota contention: chat turns use the same Max pool as daily Claude Code work | Profile switch A/B, `rate_limit_event` badge, effort control |
| Tab lifecycle: none, several, wrong project, background tab (rAF paused) | hello/projectId checks, latest tab wins, clear `isError` text asking the user to open the editor |
| Renderer limits: no stroke, shadow or per-word colour; blur is the only effect; Google Fonts over the network; no local Rust toolchain | Remotion path for signature reels; custom font `@font-face` branch in `apps/web/src/fonts/google-fonts.ts`; TypeScript-side extensions only |
| Stale-frame suspicion: the texture cache is keyed on pooled canvas identity (PLAUSIBLE, not reproduced) | Test a 3x retime clip or a 60 fps source in a 20 fps project before trusting speed-ramped exports |
| History never cleared across projects, no labels | Add `clear()` in `loadProject`, labels on commands |

### 11.2 Open questions for the user

1. **Media model:** copy into OPFS (simple, disk-hungry), linked `~/impulsion/videos` handles (zero-copy, needs a one-time permission and a schema field), or proxies for 4K HEVC rushes?
2. **Undo granularity:** one Cmd+Z per tool call (recommended, simple) or per whole Claude turn (needs a transaction held open across async tool calls)?
3. **Ripple:** AI edits always pinned off with explicit shifts (recommended), or follow the UI toggle?
4. **Apply or propose:** apply edits immediately, or stage them with `previewElements`/`commitPreview` for accept/reject in chat? Cuts of takes are always proposed first either way.
5. **Chat profile and model:** A (Max 20x) or B (Max 5x) by default? `claude-opus-5` pinned, or Sonnet 5 for speed?
6. **Chat tool surface:** editor tools only (`tools: []`, strict MCP config), or also Read/Glob and selected user MCP servers?
7. **Reel look:** rebuild karaoke, face-anchored zoom and the cutout layer natively in OpenCut (renderer work), or keep Remotion as the final reel renderer fed from the editor state?
8. **Transcript persistence:** in a dedicated IndexedDB store, on the sidecar keyed by content hash (readable without the tab), or both (recommended)?
9. **Export and import folders on disk** (allow-list roots, `exports/` target)?
10. **Keep Freesound** (needs an API key) or drop the Sounds tab?
11. **UI language:** switch the whole UI to French, per the Impulsion convention?
12. **Retire CapCut and review-video (4602)** once bookmarks and the editor cover them?
13. **Ignore `apps/desktop`** (GPUI/Rust shell)? It seems irrelevant.

### 11.3 Reader contradictions resolved by reading the code

| Topic | Readers said | Code says (verified) |
|---|---|---|
| TimelineManager return values | "Most wrappers return void" vs "splitElements/duplicateElements return refs" | Both partly right: `splitElements` returns `getRightSideElements()`, `duplicateElements` returns refs, `addTrack` returns a trackId, `addClipEffect` returns an effectId; `insertElement`, `deleteElements`, `moveElements` and `updateElements` return void |
| `ExportOptions.fps` | `fps: number` (shell reader) | `fps?: FrameRate` (`apps/web/src/export/index.ts`); `ExportButton` passes `settings.fps` |
| Ripple override from the bridge | "Writing the flag directly is overwritten on the next render" | The effect in `EditorRuntimeBindings` depends on `[editor, rippleEditingEnabled]` and only re-runs when the store value changes. A synchronous save, set, restore around one `execute` is safe |
| Dev port and binding | `package.json` script vs running process | The script is `next dev --turbopack` (no port). The running process is `next dev --turbopack -p 3456`, listening on `*:3456` |
| `caption-defaults.ts` | Cited by one reader only | Exists: `apps/web/src/transcription/caption-defaults.ts` |
| Text font size | "fontSize 5" vs "default 15" | Both: `SUBTITLE_FONT_SIZE = 5` for captions, `DEFAULTS.text` fontSize 15 for plain text |
| Bridge mount point | `EditorRuntimeBindings` vs editor `page.tsx` | Either works for editor tools. The root layout is preferred so the connection survives `/projects` to `/editor` navigation; editor tools check readiness |
| Unknown project id | "Silently creates Untitled Project" | Confirmed in `EditorProvider`: a `loadProject` "not found" error leads to `createNewProject` and `router.replace` |
| `layout_cards` signature | `(cards, total, max_lines)` | `layout_cards(cards, mapping_end, max_lines=3)`; `detect_faces(src, mapping, work, crop_box, size=(540,960))` |
