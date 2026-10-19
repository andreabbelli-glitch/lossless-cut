# Personal Windows build

This fork starts from the source tree of `e7b1ced0589d7670e94cd7ad2f412e1ea157dddf` (3.70.0), with its bundled FFmpeg. The original 3.69.0 installation is kept separately. The personal changes use the current branch; upstream history is preserved.

## Export guarantees and coverage

Export completion means that the candidate passed verification. Created, skipped, cancelled and failed operations have distinct outcomes. Verification runs in the main process; editing and navigation remain available during the checks.

- A single export checks structure, selected tracks and decoded start/end windows.
- A merge also streams through all output packets once and decodes local windows around every join. Packet PTS may legitimately be reordered by B-frames; DTS and presented frame clocks are checked separately.
- Matching source content must retain one common timeline shift across every selected track in each retained segment. Existing offsets are preserved. The video timing bound and per-stream sample/priming checks remain separate.
- Whole-merge packet coverage does not imply whole-file decoded content coverage. Memory and ambiguity limits produce an inconclusive result, never wider timing tolerances.

Unsafe ordinary copy boundaries are rejected. Alternative boundaries appear in the existing export panel with the included/excluded ranges and a preview action. They are candidates, and the final verification remains decisive. Common-clock spans can override concat container durations only after boundary proof; microsecond rounding uses cumulative boundaries.

Smart Cut encodes the video borders and copies proven complete GOPs. Pixel depth, profile, colour and source clocks are retained. Encoding the whole selection requires explicit consent in the export panel. The existing bitrate heuristic is unchanged. Non-video tracks are copied once from the original under the same source timeline.

AAC decoder overlap can change at a discontinuity even when copied packet hashes match. The verifier checks decoded samples as well as packet lineage and rejects an uncertifiable splice. Source-aware merge references avoid comparing the final continuous decoder state with an independently restarted decoder for each part.

Repetitive AAC content can also leave correspondence ambiguous even when the copied payloads and clocks are correct. Such a result remains inconclusive; the verifier does not widen timing tolerances to accept it. The source preceding the historical real-world 18 ms case is unavailable, so the cause of that particular case remains uncertified.

For merge-only exports, copied AAC intermediates can remain `pending-merge` after their other checks, with decoded content coverage explicitly incomplete. They are not published over previous segment files or treated as standalone successes. Only the final merge's original-source PCM boundary proof can authorize success and cleanup. Separate-file and merge-plus-separate exports retain all per-part boundary checks, including initial/final PCM.

## Publication and recovery

Only overwriting an existing destination creates a staged candidate. A fresh output is written directly to its selected path. A validated replacement retains the old destination as `.losslesscut-<UUID>.previous.<extension>`. Failed or cancelled candidates remain available for inspection; the previous destination stays intact.

Intermediate files are deleted only after a created, verified final merge. A skipped merge does not authorize deleting newly created segments. Compression provenance, including Stash UUID/profile and comment fallback, is preserved independently of ordinary global metadata stripping.

## Build and checks

The verified local toolchain uses Node 24, Corepack/Yarn 4, Electron 42 and the FFmpeg downloaded by this revision's script. From the repository:

```powershell
corepack yarn install --immutable
corepack yarn download-ffmpeg-win32-x64
corepack yarn tsc
corepack yarn lint
corepack yarn test run --maxWorkers=2
corepack yarn build
node node_modules/electron-builder/cli.js --win dir --x64
corepack yarn release-notes e7b1ced0589d7670e94cd7ad2f412e1ea157dddf
```

Make Yarn available on the packaging process's `PATH` through Corepack. Do not change the supported FFmpeg to reproduce an old audit. Media tests generate isolated synthetic files and use the bundled binaries.

The test suite includes Main10/B-frames/VFR, inherited offsets, multiple audio tracks, nonzero origins, AAC priming, missing/extra frames, wrong waveforms, explicit audio conversions, cancellation, Windows file locks and existing-output recovery. `concatPipeline.test.ts` calls the production concat hook with twelve parts and eleven joins. `smartCutPipeline.test.ts` calls the production cut pipeline. Electron UI replays additionally cover consent, boundary proposals, file switching, skipped merge cleanup, FPS input and naming collisions.

Performance profiling is external to the product. The measured UI sequence reduces repeated DOM/layout/script work while preserving similar input latency; it does not establish a universal speedup. Physical Safari/iPhone playback remains a separate device check.

The portable delivery includes a saved configuration, an isolated launcher, build hashes and a rollback launcher for the untouched 3.69.0 installation. See the delivery README and the consolidated Stash dossier for the per-finding decisions, independent reviews and final build results.
