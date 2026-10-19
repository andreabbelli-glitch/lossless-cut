import { useCallback } from 'react';
import sum from 'lodash/sum';
import pMap from 'p-map';
import invariant from 'tiny-invariant';

import { getSuffixedOutPath, transferTimestamps, getOutFileExtension, getOutDir, getHtml5ifiedPath, unlinkWithRetry, getFrameDuration, isMac, html5ifiedPrefix, html5dummySuffix, assertFileExists } from '../util';
import { runFfmpegWithProgress, getFfCommandLine, getDuration, createChaptersFromSegments, createFileMetadataReader, readFileFfprobeMeta, getExperimentalArgs, getVideoTimescaleArgs, logStdoutStderr, runFfmpegConcat, RefuseOverwriteError, runFfmpeg, findKeyframeNearTime, planVideoCopyRangeWithSignal } from '../ffmpeg';
import { getEffectiveAvoidNegativeTs, getKeyframeCutSeekCompensation, getMapStreamsArgs, getStreamIdsToCopy, isCopyingOnlyAudioStreams, isCropActive, isAspectRatioActive } from '../util/streams';
import { needsSmartCut, getCodecParams } from '../smartcut';
import { getGuaranteedSegments, isDurationValid } from '../segments';
import type { FFprobeStream } from '../../../common/ffprobe';
import type { AvoidNegativeTs, FfmpegHwAccel, Html5ifyMode, PreserveMetadata } from '../../../common/types';
import { deleteDispositionValue, type AllFilesMeta, type Chapter, type CopyfileStreams, type LiteFFprobeStream, type ParamsByFile, type SegmentToExport } from '../types';
import type { LossyMode } from '../../../main';
import { UserFacingError } from '../../errors';
import mainApi from '../mainApi';
import { formatFfmpegNumber, parseFfprobeDuration, getFixChannelLayoutFilter, getHwaccelArgs, hasCustomChannelLayout } from '../../../common/util';
import { join, resolve, dirname } from '../util/path';
import { escapeFfmetadata, getProvenanceMetadataArgs, getMergedProvenanceMetadataArgs, isExpectedAttachmentExit } from '../../../common/exportMetadata';
import { getCommonMovieTimescale, getSmartCutVideoArgs } from '../../../common/smartCut';
import { getCompatibleTimingArgs, type CompatibleCut } from '../../../common/compatibleCuts';
import { buildConcatInput } from '../../../common/concatInput';
import { getLosslessCutRange } from '../../../common/losslessCutRange';
import type { VerificationSource } from '../../../main/exportVerification';
import { ExportVerificationError, validateOutput, writeValidatedOutput, type VerificationPhase } from '../util/validatedOutput';
import { getStreamConversionVerification } from '../util/streamConversionVerification';

const { writeFile, mkdir, access, constants: { W_OK } } = window.require('node:fs/promises');


export class OutputNotWritableError extends Error {
  constructor() {
    super();
    this.name = 'OutputNotWritableError';
  }
}

export class WholeSegmentEncodingRequiredError extends UserFacingError {
  constructor() { super('Smart Cut requires encoding this entire selection. Confirm this in the export panel or choose a compatible keyframe.'); this.name = 'WholeSegmentEncodingRequiredError'; }
}

async function writeChaptersFfmetadata(outDir: string, chapters: Chapter[] | undefined) {
  if (!chapters || chapters.length === 0) return undefined;

  const path = join(outDir, `ffmetadata-${Date.now()}.txt`);

  const ffmetadata = chapters.map(({ start, end, name }) => (
    `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.floor(start * 1000)}\nEND=${Math.floor(end * 1000)}\ntitle=${escapeFfmetadata(name || '')}`
  )).join('\n\n');
  console.log('Writing chapters', ffmetadata);
  await writeFile(path, ffmetadata);
  return path;
}

// Muxers implemented by ffmpeg's movenc.c, i.e. the ones that accept `-movflags`.
// Note: deliberately not util/streams.ts `isMov`, which is a narrower, UI oriented list.
const movencFormats = new Set(['3g2', '3gp', 'f4v', 'ipod', 'ismv', 'mov', 'mp4', 'psp']);

// Muxers implemented by ffmpeg's matroskaenc.c, i.e. the ones that accept `-default_mode`.
const matroskaencFormats = new Set(['matroska', 'webm']);

// ffmpeg tolerates private options belonging to a different muxer, but they add noise to the command line
// that we log, show in "Last commands" and include in error reports - which makes troubleshooting harder.
// If the output format is unknown, ffmpeg infers the muxer from the file extension, so keep the flags to be safe.
function getMovFlags({ outFormat, preserveMovData, movFastStart }: { outFormat: string | undefined, preserveMovData: boolean, movFastStart: boolean }) {
  if (outFormat != null && !movencFormats.has(outFormat)) return [];

  const flags: string[] = [];

  // https://video.stackexchange.com/a/26084/29486
  // https://github.com/mifi/lossless-cut/issues/331#issuecomment-623401794
  if (preserveMovData) flags.push('+use_metadata_tags');

  // https://github.com/mifi/lossless-cut/issues/347
  if (movFastStart) flags.push('+faststart');

  if (flags.length === 0) return [];
  return flags.flatMap((flag) => ['-movflags', flag]);
}

// same as getMovFlags, but for the matroska muxer's private options
function getMatroskaFlags(outFormat: string | undefined) {
  if (outFormat != null && !matroskaencFormats.has(outFormat)) return [];

  return [
    '-default_mode', 'infer_no_subs',
    // because it makes sense to not force subtitles disposition to "default" if they were not default in the input file
    // after some testing, it seems that default is actually "infer", contrary to what is documented (ffmpeg doc says "passthrough" is default)
    // https://ffmpeg.org/ffmpeg-formats.html#Options-8
    // https://github.com/mifi/lossless-cut/issues/972#issuecomment-1015176316
  ];
}

const getChaptersInputArgs = (ffmetadataPath: string | undefined) => (ffmetadataPath ? ['-f', 'ffmetadata', '-i', ffmetadataPath] : []);

async function tryDeleteFiles(paths: string[]) {
  return pMap(paths, (path) => unlinkWithRetry(path).catch((err) => console.error('Failed to delete', path, err)), { concurrency: 5 });
}

export async function maybeMkDeepOutDir({ outputDir, fileOutPath }: { outputDir: string, fileOutPath: string }) {
  // cutFileNames might contain slashes and therefore might have a subdir(tree) that we need to mkdir
  // https://github.com/mifi/lossless-cut/issues/1532
  const actualOutputDir = dirname(fileOutPath);
  if (actualOutputDir !== outputDir) await mkdir(actualOutputDir, { recursive: true });
}


function useFfmpegOperations({ filePath, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, isEncoding, lossyMode, enableOverwriteOutput, outputPlaybackRate, cutFromAdjustmentFrames, cutToAdjustmentFrames, appendLastCommandsLog, encCustomBitrate, appendFfmpegCommandLog, ffmpegHwaccel, allowWholeSegmentEncode = false }: {
  allowWholeSegmentEncode?: boolean | undefined,
  filePath: string | undefined,
  treatInputFileModifiedTimeAsStart: boolean,
  treatOutputFileModifiedTimeAsStart: boolean | null | undefined,
  enableOverwriteOutput: boolean,
  isEncoding: boolean,
  lossyMode: LossyMode | undefined,
  outputPlaybackRate: number,
  cutFromAdjustmentFrames: number,
  cutToAdjustmentFrames: number,
  appendLastCommandsLog: (a: string) => void,
  encCustomBitrate: number | undefined,
  appendFfmpegCommandLog: (args: string[]) => void,
  ffmpegHwaccel: FfmpegHwAccel,
}) {
  const shouldSkipExistingFile = useCallback(async (path: string) => {
    const fileExists = await mainApi.pathExists(path);

    // If output file exists, check that it is writable, so we can inform user if it's not (or else ffmpeg will fail with "Permission denied")
    // this seems to sometimes happen on Windows, not sure why.
    if (fileExists) {
      try {
        await access(path, W_OK);
      } catch {
        throw new OutputNotWritableError();
      }
    }
    const shouldSkip = !enableOverwriteOutput && fileExists;
    if (shouldSkip) console.log('Not overwriting existing file', path);
    return shouldSkip;
  }, [enableOverwriteOutput]);

  const getOutputPlaybackRateArgs = useCallback(() => (outputPlaybackRate !== 1 ? ['-itsscale', String(1 / outputPlaybackRate)] : []), [outputPlaybackRate]);

  const concatFiles = useCallback(async ({ paths, outDir, outPath, metadataFromPath, includeAllStreams, streams, outFormat, ffmpegExperimental, onProgress = () => undefined, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, videoTimebase, onVerification, ownedCandidate = false, signal, readMetadata = createFileMetadataReader(signal), verificationSources, certifiedDurations }: {
    certifiedDurations?: number[] | undefined,
    verificationSources?: VerificationSource[] | undefined,
    signal?: AbortSignal | undefined,
    readMetadata?: ReturnType<typeof createFileMetadataReader>,
    ownedCandidate?: boolean,
    onVerification?: VerificationPhase | undefined,
    paths: string[],
    outDir: string | undefined,
    outPath: string,
    metadataFromPath: string,
    includeAllStreams: boolean,
    streams: FFprobeStream[],
    outFormat?: string | undefined,
    ffmpegExperimental: boolean,
    onProgress?: (a: number) => void,
    preserveMovData: boolean,
    movFastStart: boolean,
    chapters: Chapter[] | undefined,
    preserveMetadataOnMerge: boolean,
    videoTimebase?: number | undefined,
  }) => {
    signal?.throwIfAborted();
    const concatTxt = buildConcatInput(paths.map((path) => resolve(path)), certifiedDurations);
    if (!ownedCandidate && await shouldSkipExistingFile(outPath)) return { haveExcludedStreams: false, status: 'skipped' as const, validated: false };
    signal?.throwIfAborted();

    console.log('Merging files', { paths }, 'to', outPath);

    const metadata = await pMap(paths, readMetadata, { concurrency: 1 });
    signal?.throwIfAborted();
    const durations = metadata.map((source) => parseFfprobeDuration(source.format.duration) ?? 0);
    const totalDuration = sum(certifiedDurations ?? durations);
    const provenance = getMergedProvenanceMetadataArgs(metadata.map((source) => source.format.tags));

    let chaptersPath: string | undefined;
    if (chapters) {
      const chaptersWithNames = chapters.map((chapter, i) => ({ ...chapter, name: chapter.name || `Chapter ${i + 1}` }));
      invariant(outDir != null);
      chaptersPath = await writeChaptersFfmetadata(outDir, chaptersWithNames);
      signal?.throwIfAborted();
    }

    try {
      let inputArgs: string[] = [];
      let inputIndex = 0;

      // Keep track of input index to be used later
      // eslint-disable-next-line no-inner-declarations
      function addInput(args: string[]) {
        inputArgs = [...inputArgs, ...args];
        const retIndex = inputIndex;
        inputIndex += 1;
        return retIndex;
      }

      // concat list - always first
      addInput([
        // https://blog.yo1.dog/fix-for-ffmpeg-protocol-not-on-whitelist-error-for-urls/
        '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe,fd',
        '-i', '-',
      ]);

      let metadataSourceIndex: number | undefined;
      if (preserveMetadataOnMerge) {
        // If preserve metadata, add the first file (we will get metadata from this input)
        metadataSourceIndex = addInput(['-i', metadataFromPath]);
      }

      let chaptersInputIndex: number | undefined;
      if (chaptersPath) {
        // if chapters, add chapters source file
        chaptersInputIndex = addInput(getChaptersInputArgs(chaptersPath));
      }

      const { streamIdsToCopy, excludedStreamIds } = getStreamIdsToCopy({ streams, includeAllStreams });
      const movieTimescale = getCommonMovieTimescale(streams.filter((stream) => streamIdsToCopy.includes(stream.index)).map((stream) => stream.time_base));
      if (outFormat != null && movencFormats.has(outFormat) && movieTimescale == null) throw new UserFacingError('The selected track clocks have no representable common movie clock');
      const mapStreamsArgs = getMapStreamsArgs({
        allFilesMeta: { [metadataFromPath]: { streams } },
        copyFileStreams: [{ path: metadataFromPath, streamIds: streamIdsToCopy }],
        outFormat,
        manuallyCopyDisposition: true,
        needFlac: true, // https://github.com/mifi/lossless-cut/issues/2636
      });
      const conversionVerification = getStreamConversionVerification(mapStreamsArgs, streamIdsToCopy.map((index) => streams.find((stream) => stream.index === index)!));

      // Keep this similar to losslessCutSingle()
      const ffmpegArgs = [
        '-hide_banner',
        // Preserve AAC priming/skip information under the same timeline as video.
        '-copyts',
        // No progress if we set loglevel warning :(
        // '-loglevel', 'warning',

        ...inputArgs,

        ...mapStreamsArgs,

        // -map_metadata 0 with concat demuxer doesn't transfer metadata from the concat'ed file input (index 0) when merging.
        // So we use the first file file (index 1) for metadata
        // Can only do this if allStreams (-map 0) is set
        ...(metadataSourceIndex != null ? ['-map_metadata', String(metadataSourceIndex)] : []),

        ...(chaptersInputIndex != null ? ['-map_chapters', String(chaptersInputIndex)] : []),

        ...(outFormat != null && movencFormats.has(outFormat) ? ['-movflags', '+negative_cts_offsets', '-movie_timescale', String(movieTimescale)] : []),
        ...getMovFlags({ outFormat, preserveMovData: preserveMovData || provenance.length > 0, movFastStart }),
        ...getMatroskaFlags(outFormat),

        // See https://github.com/mifi/lossless-cut/issues/170
        '-ignore_unknown',

        ...getExperimentalArgs(ffmpegExperimental),

        ...getVideoTimescaleArgs(videoTimebase),
        ...provenance,

        ...(outFormat ? ['-f', outFormat] : []),
        '-y', outPath,
      ];

      // https://superuser.com/questions/787064/filename-quoting-in-ffmpeg-concat
      // Must add "file:" or we get "Impossible to open 'pipe:xyz.mp4'" on newer ffmpeg versions
      // https://superuser.com/questions/718027/ffmpeg-concat-doesnt-work-with-absolute-path

      const ffmpegCommandLine = getFfCommandLine('ffmpeg', ffmpegArgs);

      const fullCommandLine = `echo -e "${concatTxt.replaceAll('\n', String.raw`\n`)}" | ${ffmpegCommandLine}`;
      console.log(fullCommandLine);
      appendLastCommandsLog(fullCommandLine);

      const sources = verificationSources ?? paths.map((path) => ({ path, streamIds: streamIdsToCopy }));
      const write = async (candidate: string) => {
        signal?.throwIfAborted();
        const candidateArgs = [...ffmpegArgs.slice(0, -1), candidate];
        const result = await runFfmpegConcat({ ffmpegArgs: candidateArgs, concatTxt, totalDuration, onProgress });
        signal?.throwIfAborted();
        logStdoutStderr(result);
      };
      if (ownedCandidate) {
        await write(outPath);
        await validateOutput({ path: outPath, sources, merged: true, onVerification, signal, verificationOptions: conversionVerification });
      } else {
        const outcome = await writeValidatedOutput({ path: outPath, overwrite: enableOverwriteOutput, sources, merged: true, onVerification, write, signal, verificationOptions: conversionVerification });
        if (outcome.status === 'skipped') return { haveExcludedStreams: false, status: 'skipped' as const, validated: false };
      }

      signal?.throwIfAborted();
      await transferTimestamps({ inPath: metadataFromPath, outPath, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, duration: totalDuration });

      return { haveExcludedStreams: excludedStreamIds.length > 0, status: 'created' as const, validated: true };
    } finally {
      if (chaptersPath) await tryDeleteFiles([chaptersPath]);
    }
  }, [appendLastCommandsLog, enableOverwriteOutput, shouldSkipExistingFile, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  const losslessCutSingle = useCallback(async ({
    keyframeCut: ssBeforeInput, avoidNegativeTs, copyFileStreams, cutFrom, cutTo, chaptersPath, onProgress, outPath,
    fileDuration, rotation, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMovData, preserveChapters, movFastStart, paramsByFile, videoTimebase, detectedFps, compatibleTiming,
  }: {
    keyframeCut: boolean,
    avoidNegativeTs: AvoidNegativeTs | undefined,
    copyFileStreams: CopyfileStreams,
    cutFrom: number,
    cutTo: number,
    chaptersPath: string | undefined,
    onProgress: (p: number) => void,
    outPath: string,
    fileDuration: number | undefined,
    rotation: number | undefined,
    allFilesMeta: AllFilesMeta,
    outFormat: string,
    shortestFlag: boolean,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    preserveChapters: boolean,
    movFastStart: boolean,
    paramsByFile: ParamsByFile,
    videoTimebase?: number | undefined,
    detectedFps?: number | undefined,
    compatibleTiming?: CompatibleCut | undefined,
  }) => {
    const frameDuration = getFrameDuration(detectedFps);

    const { cuttingStart, cuttingEnd, adjustedFrom: cutFromWithAdjustment, duration: cutDuration } = getLosslessCutRange({ cutFrom, cutTo, fileDuration, frameDuration, cutFromAdjustmentFrames: compatibleTiming ? 0 : cutFromAdjustmentFrames, cutToAdjustmentFrames: compatibleTiming ? 0 : cutToAdjustmentFrames });
    const areWeCutting = cuttingStart || cuttingEnd;
    if (areWeCutting) console.log('Cutting from', cuttingStart ? `${cutFrom} (${cutFromWithAdjustment} adjusted ${cutFromAdjustmentFrames} frames)` : 'start', 'to', cuttingEnd ? `${cutTo} (adjusted ${cutToAdjustmentFrames} frames)` : 'end');

    const copyFileStreamsFiltered = copyFileStreams.filter(({ streamIds }) => streamIds.length > 0);
    const compatibleArgs = compatibleTiming ? getCompatibleTimingArgs(compatibleTiming) : undefined;
    if (compatibleArgs) invariant(copyFileStreamsFiltered.length === 1, 'Compatible timing requires one source');

    // Undo ffmpeg's earlier seek for Matroska with B-frames, so the cut doesn't start one keyframe too early (#1216)
    // `-itsoffset` keeps the output's zero point (and so `-t`) at the original cut start. Only for a single input with `-ss` before `-i`.
    const singleInputMeta = copyFileStreamsFiltered.length === 1 ? allFilesMeta[copyFileStreamsFiltered[0]!.path] : undefined;
    const seekCompensation = ssBeforeInput && cuttingStart && singleInputMeta != null
      ? getKeyframeCutSeekCompensation({ formatName: singleInputMeta.format.format_name, streams: singleInputMeta.streams, cutFrom: cutFromWithAdjustment })
      : 0;

    // Don't cut if not needed: https://github.com/mifi/lossless-cut/issues/50
    const cutFromArgs = cuttingStart ? ['-ss', formatFfmpegNumber(cutFromWithAdjustment + seekCompensation)] : [];
    const seekCompensationArgs = seekCompensation > 0 ? ['-itsoffset', formatFfmpegNumber(seekCompensation)] : [];
    const cutToArgs = cuttingEnd ? ['-t', formatFfmpegNumber(cutDuration)] : [];

    // remove -avoid_negative_ts make_zero when not cutting start (no -ss), or else some videos get blank first frame in QuickLook
    // note: `make_zero`/`make_non_negative` get downgraded to `auto` when copying a cover art stream, or else the
    // output gets the segment's end time as its duration, see https://github.com/mifi/lossless-cut/issues/3009
    const effectiveAvoidNegativeTs = getEffectiveAvoidNegativeTs({ avoidNegativeTs, allFilesMeta, copyFileStreams: copyFileStreamsFiltered });
    const avoidNegativeTsArgs = cuttingStart && effectiveAvoidNegativeTs && ssBeforeInput ? ['-avoid_negative_ts', String(effectiveAvoidNegativeTs)] : [];

    // When seeking after the input (keyframe cut mode off), keep leading non-keyframe packets for audio-only exports,
    // or else the cut starts late for audio files where not all packets are flagged as keyframes. See isCopyingOnlyAudioStreams
    const copyInitialNonKeyframesArgs = cuttingStart && !ssBeforeInput && isCopyingOnlyAudioStreams({ allFilesMeta, copyFileStreams: copyFileStreamsFiltered }) ? ['-copyinkf'] : [];

    // If cutting multiple files, `-ss` must be before `-i`, regardless of `ssBeforeInput` choice
    // and it seems that `-t` must be after `-i` #896
    const inputFilesArgs = compatibleArgs
      ? [...compatibleArgs.beforeInput, '-i', copyFileStreamsFiltered[0]!.path]
      : (copyFileStreamsFiltered.length > 1
        ? copyFileStreamsFiltered.flatMap(({ streamIds, path }) => {
          const fileParams = paramsByFile.get(path);
          // Don't cut/seek cover art or images attached by users - it will break them, see https://github.com/mifi/lossless-cut/issues/2884
          const streamParams = streamIds.map((streamId) => fileParams?.paramsByStream.get(streamId));
          if (streamIds.length === 1 && streamParams[0]?.disposition === 'attached_pic') {
            return ['-i', path];
          }

          const itsOffsetArgs = fileParams?.offset ? ['-itsoffset', formatFfmpegNumber(fileParams.offset)] : [];

          return [
            ...cutFromArgs,
            ...itsOffsetArgs,
            '-i', path,
            ...cutToArgs,
          ];
        })
        : [
          ...(ssBeforeInput ? [...cutFromArgs, ...seekCompensationArgs] : []),
          '-i', copyFileStreamsFiltered[0]!.path,
          ...(!ssBeforeInput ? cutFromArgs : []),
          ...cutToArgs,
        ]);

    const chaptersInputIndex = copyFileStreamsFiltered.length;

    const rotationArgs = rotation !== undefined ? ['-display_rotation:v:0', String(360 - rotation)] : [];

    // This function tries to calculate the output stream index needed for -metadata:s:x and -disposition:x arguments
    // It is based on the assumption that copyFileStreamsFiltered contains the order of the input files (and their respective streams orders) sent to ffmpeg, to hopefully calculate the same output stream index values that ffmpeg does internally.
    // It also takes into account previously added files that have been removed and disabled streams.
    function mapInputStreamIndexToOutputIndex(inputFilePath: string, inputFileStreamIndex: number) {
      let streamCount = 0;
      // Count copied streams of all files until this input file
      const foundFile = copyFileStreamsFiltered.find(({ path: path2, streamIds }) => {
        if (path2 === inputFilePath) return true;
        streamCount += streamIds.length;
        return false;
      });
      if (!foundFile) return undefined; // Could happen if a tag has been edited on an external file, then the file was removed

      // Then add the index of the current stream index to the count
      const copiedStreamIndex = foundFile.streamIds.indexOf(inputFileStreamIndex);
      if (copiedStreamIndex === -1) return undefined; // Could happen if a tag has been edited on a stream, but the stream is disabled
      return streamCount + copiedStreamIndex;
    }

    invariant(filePath != null);
    const provenance = getProvenanceMetadataArgs(allFilesMeta[filePath]?.format?.tags);

    const customFileMetadataArgs = Object.entries(paramsByFile.get(filePath)?.metadata ?? {}).flatMap(([key, value]) => [
      '-metadata', `${key}=${value}`,
    ]);

    const mapStreamsArgs = getMapStreamsArgs({ copyFileStreams: copyFileStreamsFiltered, allFilesMeta, outFormat, needFlac: areWeCutting });

    const customParamsArgs = (() => {
      const ret: string[] = [];
      const compatibleFilters = new Map<number, string[]>();
      for (const filter of compatibleArgs?.filters ?? []) {
        const outputIndex = mapInputStreamIndexToOutputIndex(copyFileStreamsFiltered[0]!.path, filter.streamIndex);
        if (outputIndex != null) compatibleFilters.set(outputIndex, [filter.expression]);
      }
      for (const [fileId, { paramsByStream }] of paramsByFile.entries()) {
        for (const [streamId, streamParams] of paramsByStream.entries()) {
          const outputIndex = mapInputStreamIndexToOutputIndex(fileId, streamId);
          if (outputIndex != null) {
            const { disposition } = streamParams;
            if (disposition != null) {
              // "0" means delete the disposition for this stream
              const dispositionArg = disposition === deleteDispositionValue ? '0' : disposition;
              ret.push(`-disposition:${outputIndex}`, String(dispositionArg));
            }

            const bitstreamFilters: string[] = compatibleFilters.get(outputIndex) ?? [];
            compatibleFilters.delete(outputIndex);
            if (streamParams.bsfH264Mp4toannexb) bitstreamFilters.push('h264_mp4toannexb');
            if (streamParams.bsfHevcMp4toannexb) bitstreamFilters.push('hevc_mp4toannexb');
            if (streamParams.bsfHevcAudInsert) bitstreamFilters.push('hevc_metadata=aud=insert');

            const getFileStreams = () => allFilesMeta[fileId]?.streams;
            const getStream = () => getFileStreams()?.find((s) => s.index === streamId);

            // Lossless crop via codec bitstream metadata (#643)
            if (isCropActive(streamParams.crop)) {
              const { left, right, top, bottom } = streamParams.crop;
              // Look up codec_name from allFilesMeta to determine the correct bitstream filter
              const streamInfo = getStream();
              const codecName = streamInfo?.codec_name;

              const cropParams = `crop_left=${left}:crop_right=${right}:crop_top=${top}:crop_bottom=${bottom}`;
              if (codecName === 'h264') {
                bitstreamFilters.push(`h264_metadata=${cropParams}`);
              } else if (codecName === 'hevc') {
                bitstreamFilters.push(`hevc_metadata=${cropParams}`);
              }
            }

            // Lossless aspect ratio (SAR) via codec bitstream metadata (#643)
            if (isAspectRatioActive(streamParams.aspectRatio)) {
              const { num, den } = streamParams.aspectRatio;
              const streamInfo = getStream();
              const codecName = streamInfo?.codec_name;

              if (codecName === 'h264') {
                bitstreamFilters.push(`h264_metadata=sample_aspect_ratio=${num}/${den}`);
              } else if (codecName === 'hevc') {
                bitstreamFilters.push(`hevc_metadata=sample_aspect_ratio=${num}/${den}`);
              } else {
                // For non-H264/HEVC codecs, use container-level -aspect flag
                ret.push('-aspect', `${num}:${den}`);
              }
            }

            if (bitstreamFilters.length > 0) {
              ret.push(`-bsf:${outputIndex}`, bitstreamFilters.join(','));
            }

            if (streamParams.tag != null) {
              ret.push(`-tag:${outputIndex}`, streamParams.tag);
            }

            // custom stream metadata
            if (streamParams.metadata != null) {
              for (const [tag, value] of Object.entries(streamParams.metadata)) {
                ret.push(`-metadata:s:${outputIndex}`, `${tag}=${value}`);
              }
            }
          }
        }
      }
      for (const [outputIndex, filters] of compatibleFilters) ret.push(`-bsf:${outputIndex}`, filters.join(','));
      return ret;
    })();

    function getPreserveMetadata() {
      if (preserveMetadata === 'default') return ['-map_metadata', '0']; // todo isn't this ffmpeg default and can be omitted? https://stackoverflow.com/a/67508734/6519037
      if (preserveMetadata === 'none') return ['-map_metadata', '-1'];
      if (preserveMetadata === 'nonglobal') return ['-map_metadata:g', '-1']; // https://superuser.com/a/1546267/658247
      return [];
    }

    function getPreserveChapters() {
      if (chaptersPath) return ['-map_chapters', String(chaptersInputIndex)];
      // todo should preserve chapters be hardcoded (and disabled in UI) when segmentsToChaptersOnly mode is enabled?
      if (!preserveChapters) return ['-map_chapters', '-1']; // https://github.com/mifi/lossless-cut/issues/2176
      return []; // default: includes chapters from input
    }

    const ffmpegArgs = [
      '-hide_banner',
      // No progress if we set loglevel warning :(
      // '-loglevel', 'warning',

      ...getOutputPlaybackRateArgs(),

      ...rotationArgs,

      ...inputFilesArgs,
      ...getChaptersInputArgs(chaptersPath),

      ...(compatibleArgs?.afterInput ?? avoidNegativeTsArgs),

      ...copyInitialNonKeyframesArgs,

      ...mapStreamsArgs,

      ...getPreserveMetadata(),

      ...getPreserveChapters(),

      ...(shortestFlag ? ['-shortest'] : []),

      ...getMovFlags({ outFormat, preserveMovData: preserveMovData || provenance.length > 0, movFastStart }),
      ...getMatroskaFlags(outFormat),

      ...customFileMetadataArgs,

      ...customParamsArgs,
      ...provenance,

      // See https://github.com/mifi/lossless-cut/issues/170
      '-ignore_unknown',

      ...getExperimentalArgs(ffmpegExperimental),

      ...getVideoTimescaleArgs(videoTimebase),

      '-f', outFormat, '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration: cutDuration, onProgress });
    logStdoutStderr(result);

    await transferTimestamps({ inPath: filePath, outPath, cutFrom, cutTo, treatInputFileModifiedTimeAsStart, duration: isDurationValid(fileDuration) ? fileDuration : undefined, treatOutputFileModifiedTimeAsStart });
  }, [appendFfmpegCommandLog, cutFromAdjustmentFrames, cutToAdjustmentFrames, filePath, getOutputPlaybackRateArgs, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  // inspired by https://gist.github.com/fernandoherreradelasheras/5eca67f4200f1a7cc8281747da08496e
  const cutEncodeSmartPart = useCallback(async ({ cutFrom, cutTo, outPath, outFormat, videoCodec, videoBitrate, videoTimebase, allFilesMeta, copyFileStreams, videoStreamIndex, ffmpegExperimental, videoStream, preserveMetadata, preserveMovData, movFastStart }: {
    cutFrom: number,
    cutTo: number,
    outPath: string,
    outFormat: string,
    videoCodec: string,
    videoBitrate: number,
    videoTimebase: number,
    allFilesMeta: AllFilesMeta,
    copyFileStreams: CopyfileStreams,
    videoStreamIndex: number,
    ffmpegExperimental: boolean,
    videoStream: LiteFFprobeStream,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    movFastStart: boolean,
  }) => {
    invariant(filePath != null);
    const provenance = getProvenanceMetadataArgs(allFilesMeta[filePath]?.format?.tags);

    function getVideoArgs({ streamIndex, outputIndex }: { streamIndex: number, outputIndex: number }) {
      if (streamIndex !== videoStreamIndex) return undefined;

      const compatibility = lossyMode ? [] : getSmartCutVideoArgs(videoStream, outputIndex);
      const trimArgs = (() => {
        if (lossyMode) return [];
        const [numerator, denominator] = (videoStream.time_base ?? '').split('/').map(Number);
        const tick = (numerator ?? 0) / (denominator ?? 0);
        if (!Number.isFinite(tick) || tick <= 0) throw new UserFacingError('Smart Cut cannot determine the source frame clock');
        const origin = parseFfprobeDuration(allFilesMeta[filePath!]?.format.start_time) ?? 0;
        const endPts = Math.round((origin + cutTo) / tick) - Math.round((origin + cutFrom) / tick);
        // CLI -t has a microsecond clock. An exact source frame can precede its
        // rounded value, so enforce the exclusive border on the source ticks.
        return [`-filter:${outputIndex}`, `trim=end_pts=${endPts}`];
      })();
      const args = [
        ...(compatibility.includes(`-c:${outputIndex}`) ? [] : [`-c:${outputIndex}`, videoCodec]),
        ...compatibility,
        `-b:${outputIndex}`, String(videoBitrate),
        `-fps_mode:${outputIndex}`, 'passthrough',
        `-enc_time_base:${outputIndex}`, 'demux',
        ...trimArgs,
      ];

      // seems like ffmpeg handles this itself well when encoding same source file
      // if (videoLevel != null) args.push(`-level:${outputIndex}`, videoLevel);
      // if (videoProfile != null) args.push(`-profile:${outputIndex}`, videoProfile);

      return args;
    }

    const mapStreamsArgs = getMapStreamsArgs({
      allFilesMeta,
      copyFileStreams,
      outFormat,
      getVideoArgs,
    });

    const ffmpegArgs = [
      '-hide_banner',
      // No progress if we set loglevel warning :(
      // '-loglevel', 'warning',

      '-ss', formatFfmpegNumber(cutFrom), // if we don't -ss before -i, seeking will be slow for long files, see https://github.com/mifi/lossless-cut/issues/126#issuecomment-1135451043
      '-i', filePath,
      '-ss', '0', // If we don't do this, the output seems to start with an empty black after merging with the encoded part
      '-t', formatFfmpegNumber(cutTo - cutFrom),

      ...mapStreamsArgs,

      // See https://github.com/mifi/lossless-cut/issues/170
      '-ignore_unknown',

      ...getVideoTimescaleArgs(videoTimebase),

      ...(!lossyMode && movencFormats.has(outFormat) ? ['-movie_timescale', String(videoTimebase)] : []),

      ...(preserveMetadata === 'default' ? ['-map_metadata', '0'] : (preserveMetadata === 'none' ? ['-map_metadata', '-1'] : ['-map_metadata:g', '-1'])),
      ...getMovFlags({ outFormat, preserveMovData: preserveMovData || provenance.length > 0, movFastStart }),
      ...provenance,
      ...(!lossyMode ? ['-metadata', 'losslesscut_smartcut=video-edge-reencoded-v1'] : []),

      ...getExperimentalArgs(ffmpegExperimental),

      '-f', outFormat, '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    await runFfmpeg(ffmpegArgs);
  }, [appendFfmpegCommandLog, filePath, lossyMode]);

  const cutMultiple = useCallback(async ({
    outputDir, segments: segmentsIn, cutFileNames, fileDuration, rotation, detectedFps, onProgress: onTotalProgress, keyframeCut, copyFileStreams, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMetadataOnMerge, preserveMovData, preserveChapters, movFastStart, avoidNegativeTs, paramsByFile, chapters, onVerification, compatibleTimings, signal, verifySkipped = false,
  }: {
    verifySkipped?: boolean | undefined,
    signal?: AbortSignal | undefined,
    onVerification?: VerificationPhase | undefined,
    compatibleTimings?: CompatibleCut[] | undefined,
    outputDir: string,
    customOutDir: string | undefined,
    segments: SegmentToExport[],
    cutFileNames: string[],
    fileDuration: number | undefined,
    rotation: number | undefined,
    detectedFps: number | undefined,
    onProgress: (p: number) => void,
    keyframeCut: boolean,
    copyFileStreams: CopyfileStreams,
    allFilesMeta: AllFilesMeta,
    outFormat: string | undefined,
    shortestFlag: boolean,
    ffmpegExperimental: boolean,
    preserveMetadata: PreserveMetadata,
    preserveMovData: boolean,
    preserveMetadataOnMerge: boolean,
    preserveChapters: boolean,
    movFastStart: boolean,
    avoidNegativeTs: AvoidNegativeTs | undefined,
    paramsByFile: ParamsByFile,
    chapters: Chapter[] | undefined,
  }) => {
    console.log('paramsByFile', paramsByFile);
    signal?.throwIfAborted();

    const segments = getGuaranteedSegments(segmentsIn, fileDuration);

    const singleProgresses: Record<number, number> = {};
    function onSingleProgress(id: number, singleProgress: number) {
      singleProgresses[id] = singleProgress;
      return onTotalProgress((sum(Object.values(singleProgresses)) / segments.length));
    }

    invariant(filePath != null);
    await assertFileExists(filePath);
    signal?.throwIfAborted();

    const chaptersPath = await writeChaptersFfmetadata(outputDir, chapters);
    signal?.throwIfAborted();

    // This function will either call losslessCutSingle (if no smart cut enabled)
    // or if enabled, will first cut&encode the part before the next keyframe, trying to match the input file's codec params
    // then it will cut the part *from* the keyframe to "end", and concat them together and return the concated file
    // so that for the calling code it looks as if it's just a normal segment
    const cutSegmentFile = async ({ start: desiredCutFrom, end: cutTo }: { start: number, end: number }, i: number, finalOutPath: string, cleanupPaths: string[], compatibleTiming?: CompatibleCut) => {
      const runCutStep = async <T>(run: () => Promise<T>) => {
        signal?.throwIfAborted();
        const result = await run();
        signal?.throwIfAborted();
        return result;
      };
      signal?.throwIfAborted();
      const onProgress = (progress: number) => onSingleProgress(i, progress / 2);
      const onConcatProgress = (progress: number) => onSingleProgress(i, (1 + progress) / 2);


      if (!isEncoding || compatibleTiming) {
        // simple lossless cut
        invariant(outFormat != null);
        await runCutStep(() => losslessCutSingle({
          cutFrom: desiredCutFrom, cutTo, chaptersPath, outPath: finalOutPath, copyFileStreams, keyframeCut, avoidNegativeTs, fileDuration, rotation, allFilesMeta, outFormat, shortestFlag, ffmpegExperimental, preserveMetadata, preserveMovData, preserveChapters, movFastStart, paramsByFile, detectedFps, compatibleTiming, onProgress: (progress) => onSingleProgress(i, progress),
        }));
        return { path: finalOutPath, created: true, reencodedVideo: false };
      }

      // we are probably encoding (`isEncoding`: true, smart cut or lossy mode)

      // smart cut only supports cutting main file (no externally added files)
      const { streams } = allFilesMeta[filePath]!;
      const streamsToCopyFromMainFile = copyFileStreams.find(({ path }) => path === filePath)!.streamIds
        .flatMap((streamId) => {
          const match = streams.find((stream) => stream.index === streamId);
          return match ? [match] : [];
        });

      const sourceCodecParams = await runCutStep(() => getCodecParams({ path: filePath, fileDuration, streams: streamsToCopyFromMainFile }));
      const { videoStream, videoTimebase } = sourceCodecParams;

      const videoCodec = lossyMode ? lossyMode.videoEncoder : sourceCodecParams.videoCodec;

      const copyFileStreamsFiltered = [{
        path: filePath,
        // with smart cut, we only copy/cut *one* video stream, and *all* other non-video streams (main file only)
        streamIds: streamsToCopyFromMainFile.filter((stream) => stream.index === videoStream.index || stream.codec_type !== 'video').map((stream) => stream.index),
      }];

      // eslint-disable-next-line no-shadow
      async function cutEncodeSmartPartWrapper({ cutFrom, cutTo, outPath, videoOnly = false }: { cutFrom: number, cutTo: number, outPath: string, videoOnly?: boolean }) {
        invariant(videoCodec != null);
        invariant(sourceCodecParams.videoBitrate != null);
        invariant(sourceCodecParams.videoTimebase != null);
        const encodingTimebase = sourceCodecParams.videoTimebase;
        invariant(filePath != null);
        invariant(outFormat != null);
        await runCutStep(() => cutEncodeSmartPart({ cutFrom, cutTo, outPath, outFormat, videoCodec, videoBitrate: encCustomBitrate != null ? encCustomBitrate * 1000 : sourceCodecParams.videoBitrate, videoStreamIndex: videoStream.index, videoTimebase: encodingTimebase, allFilesMeta, copyFileStreams: videoOnly ? [{ path: filePath!, streamIds: [videoStream.index] }] : copyFileStreamsFiltered, ffmpegExperimental, videoStream: sourceCodecParams.videoStream, preserveMetadata, preserveMovData, movFastStart }));
      }

      // used when the final output file was produced by encoding or concat, because they don't transfer the timestamps of the segment
      const transferSegmentTimestamps = async () => transferTimestamps({ inPath: filePath, outPath: finalOutPath, cutFrom: desiredCutFrom, cutTo, duration: isDurationValid(fileDuration) ? fileDuration : undefined, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart });

      if (lossyMode) {
        console.log('Lossy mode: cutting/encoding the whole segment', { desiredCutFrom, cutTo });
        await cutEncodeSmartPartWrapper({ cutFrom: desiredCutFrom, cutTo, outPath: finalOutPath });
        await runCutStep(transferSegmentTimestamps);
        return { path: finalOutPath, created: true, reencodedVideo: true };
      }

      invariant(outFormat != null);
      const ext = getOutFileExtension({ isCustomFormatSelected: true, outFormat, filePath });
      const attemptId = crypto.randomUUID();
      const temporaryPath = (part: string) => {
        const path = join(outputDir, `.losslesscut-smartcut-${attemptId}-${i}-${part}${ext}`);
        cleanupPaths.push(path);
        return path;
      };
      const sourceOrigin = parseFfprobeDuration(allFilesMeta[filePath]!.format.start_time) ?? 0;
      const absoluteCutFrom = sourceOrigin + desiredCutFrom;
      const absoluteCutTo = sourceOrigin + cutTo;
      const validateOriginalVideo = (path: string, from: number, to: number, reencodedVideo: boolean) => runCutStep(() => validateOutput({
        path,
        sources: [{ path: filePath!, streamIds: [videoStream.index], start: from, end: to }],
        merged: false,
        reencodedVideo,
        onVerification,
        signal,
        verificationOptions: { preserveTrackMetadata: preserveMetadata !== 'none' && paramsByFile.size === 0 },
      }));

      // Join only the video. Splitting AAC at a video keyframe creates separate
      // packet grids and makes the concat demuxer extend the adjacent video frame.
      // All other selected tracks are copied once from the original below, under
      // the same absolute source clock as the assembled video.
      const muxOriginalTracks = async (videoPath: string, firstVideoTime: number, videoReencoded: boolean) => {
        const videoMetadata = await runCutStep(() => readFileFfprobeMeta(videoPath));
        const assembledVideo = videoMetadata.streams.find((stream) => stream.codec_type === 'video');
        invariant(assembledVideo != null);
        const assembledStart = parseFfprobeDuration(assembledVideo.start_time) ?? 0;
        const selectedStreams = copyFileStreamsFiltered[0]!.streamIds.map((index) => streams.find((stream) => stream.index === index)!);
        const metadata = {
          [videoPath]: { streams: [{ ...videoStream, index: assembledVideo.index }] },
          [filePath!]: allFilesMeta[filePath!]!,
        };
        const maps = selectedStreams.flatMap((stream, outputIndex) => getMapStreamsArgs({
          startIndex: outputIndex,
          allFilesMeta: metadata,
          outFormat,
          manuallyCopyDisposition: true,
          copyFileStreams: [{ path: videoPath, streamIds: stream.index === videoStream.index ? [assembledVideo.index] : [] }, { path: filePath!, streamIds: stream.index === videoStream.index ? [] : [stream.index] }],
        }));
        const movieTimescale = getCommonMovieTimescale(selectedStreams.map((stream) => stream.time_base));
        if (movieTimescale == null) throw new UserFacingError('The selected track clocks have no representable common movie clock');
        const provenance = getProvenanceMetadataArgs(allFilesMeta[filePath!]!.format.tags);
        const args = [
          '-hide_banner', '-copyts',
          ...(rotation != null ? ['-display_rotation:v:0', String(360 - rotation)] : []),
          '-itsoffset', formatFfmpegNumber(absoluteCutFrom + firstVideoTime - assembledStart), '-i', videoPath,
          '-ss', formatFfmpegNumber(desiredCutFrom), '-i', filePath!,
          ...getChaptersInputArgs(chaptersPath),
          '-to', formatFfmpegNumber(absoluteCutTo),
          ...maps,
          ...(preserveMetadata === 'default' ? ['-map_metadata', '1'] : (preserveMetadata === 'none' ? ['-map_metadata', '-1'] : ['-map_metadata:g', '-1'])),
          '-map_chapters', chaptersPath ? '2' : (preserveChapters ? '1' : '-1'),
          '-avoid_negative_ts', 'disabled', '-output_ts_offset', formatFfmpegNumber(-absoluteCutFrom),
          ...(movencFormats.has(outFormat) ? ['-movflags', '+negative_cts_offsets', '-movie_timescale', String(movieTimescale)] : []),
          ...getVideoTimescaleArgs(videoTimebase),
          ...getMovFlags({ outFormat, preserveMovData: preserveMovData || provenance.length > 0, movFastStart }),
          ...getMatroskaFlags(outFormat), ...provenance,
          ...(videoReencoded ? ['-metadata', 'losslesscut_smartcut=video-edge-reencoded-v1'] : []),
          ...getExperimentalArgs(ffmpegExperimental), '-ignore_unknown', '-f', outFormat, '-y', finalOutPath,
        ];
        appendFfmpegCommandLog(args);
        await runCutStep(() => runFfmpegWithProgress({ ffmpegArgs: args, duration: cutTo - desiredCutFrom, onProgress: onConcatProgress }));
        await runCutStep(transferSegmentTimestamps);
        return { path: finalOutPath, created: true, reencodedVideo: videoReencoded };
      };

      const cutEncodeWholePart = async () => {
        if (!allowWholeSegmentEncode) throw new WholeSegmentEncodingRequiredError();
        const encoded = temporaryPath('whole-video');
        await cutEncodeSmartPartWrapper({ cutFrom: desiredCutFrom, cutTo, outPath: encoded, videoOnly: true });
        await validateOriginalVideo(encoded, desiredCutFrom, cutTo, true);
        const metadata = await runCutStep(() => readFileFfprobeMeta(encoded));
        const firstTime = parseFfprobeDuration(metadata.streams.find((stream) => stream.codec_type === 'video')?.start_time) ?? 0;
        return muxOriginalTracks(encoded, firstTime, true);
      };

      if (!['h264', 'hevc'].includes(videoStream.codec_name ?? '') || !movencFormats.has(outFormat)) return cutEncodeWholePart();

      const sourceVideo = (await runCutStep(() => readFileFfprobeMeta(filePath))).streams.find((stream) => stream.index === videoStream.index);
      const videoOrigin = parseFfprobeDuration(sourceVideo?.start_time) ?? sourceOrigin;
      const [tickNumerator, tickDenominator] = (videoStream.time_base ?? '').split('/').map(Number);
      const sourceTick = (tickNumerator ?? 0) / (tickDenominator ?? 0);
      const videoDuration = parseFfprobeDuration(sourceVideo?.duration);
      const videoEnd = videoDuration == null ? undefined : videoOrigin + videoDuration - sourceOrigin;
      const toEnd = videoEnd != null && Number.isFinite(sourceTick) && sourceTick > 0 && cutTo >= videoEnd - sourceTick;
      const first = await runCutStep(() => needsSmartCut({ path: filePath, desiredCutFrom: absoluteCutFrom, videoStream }));
      const last = toEnd ? undefined : await runCutStep(() => findKeyframeNearTime({ filePath, streamIndex: videoStream.index, time: absoluteCutTo, mode: 'before' }));
      let copyFrom = first.losslessCutFrom - sourceOrigin;
      let copyTo = toEnd ? videoEnd! : (last == null ? copyFrom : last - sourceOrigin);
      if (!Number.isFinite(copyFrom) || copyTo <= copyFrom) return cutEncodeWholePart();
      const requestedCopy = { start: sourceOrigin + copyFrom - videoOrigin, end: sourceOrigin + copyTo - videoOrigin };
      const plan = await runCutStep(() => (signal
        ? planVideoCopyRangeWithSignal({ path: filePath, streamIndex: videoStream.index, range: requestedCopy, signal, toEnd })
        : mainApi.planVideoCopyRange({ path: filePath, streamIndex: videoStream.index, range: requestedCopy, toEnd })));
      const timing = plan.segments[0];
      const sameTick = (a: number, b: number) => Number.isFinite(sourceTick) && sourceTick > 0 && Math.round(a / sourceTick) === Math.round(b / sourceTick);
      if (!plan.possible || timing == null || !sameTick(timing.start, requestedCopy.start) || !sameTick(timing.end, requestedCopy.end)) return cutEncodeWholePart();
      copyFrom = timing.seekFrom - sourceOrigin;
      copyTo = toEnd ? videoEnd! : timing.readTo! - sourceOrigin;

      const videoParts: string[] = [];
      let firstVideoTime = timing.seekFrom - absoluteCutFrom;
      if (copyFrom > desiredCutFrom) {
        const prefix = temporaryPath('prefix-video');
        await cutEncodeSmartPartWrapper({ cutFrom: desiredCutFrom, cutTo: copyFrom, outPath: prefix, videoOnly: true });
        await validateOriginalVideo(prefix, desiredCutFrom, copyFrom, true);
        const metadata = await runCutStep(() => readFileFfprobeMeta(prefix));
        firstVideoTime = parseFfprobeDuration(metadata.streams.find((stream) => stream.codec_type === 'video')?.start_time) ?? 0;
        videoParts.push(prefix);
      }
      const copied = temporaryPath('copy-video');
      await runCutStep(() => losslessCutSingle({
        cutFrom: copyFrom,
        cutTo: copyTo,
        chaptersPath: undefined,
        outPath: copied,
        copyFileStreams: [{ path: filePath, streamIds: [videoStream.index] }],
        compatibleTiming: timing,
        keyframeCut: true,
        avoidNegativeTs: undefined,
        fileDuration,
        rotation: undefined,
        allFilesMeta,
        outFormat,
        shortestFlag: false,
        ffmpegExperimental,
        preserveMetadata,
        preserveMovData,
        preserveChapters: false,
        movFastStart,
        paramsByFile,
        videoTimebase,
        detectedFps,
        onProgress,
      }));
      await validateOriginalVideo(copied, copyFrom, copyTo, false);
      videoParts.push(copied);
      if (!toEnd && copyTo < cutTo) {
        const tail = temporaryPath('tail-video');
        await cutEncodeSmartPartWrapper({ cutFrom: copyTo, cutTo, outPath: tail, videoOnly: true });
        await validateOriginalVideo(tail, copyTo, cutTo, true);
        videoParts.push(tail);
      }
      let assembled = copied;
      if (videoParts.length > 1) {
        assembled = temporaryPath('assembled-video');
        const copiedMetadata = await runCutStep(() => readFileFfprobeMeta(copied));
        try {
          await runCutStep(() => concatFiles({ paths: videoParts, outDir: outputDir, outPath: assembled, metadataFromPath: copied, outFormat, includeAllStreams: true, streams: copiedMetadata.streams, ffmpegExperimental, preserveMovData, movFastStart, chapters: undefined, preserveMetadataOnMerge, videoTimebase, onProgress: onConcatProgress, onVerification, ownedCandidate: true, signal }));
        } catch (error) {
          if (!(error instanceof ExportVerificationError)) throw error;
          return cutEncodeWholePart();
        }
      }
      return muxOriginalTracks(assembled, firstVideoTime, videoParts.length > 1);
    };

    const cutSegment = async (segment: { start: number, end: number }, index: number) => {
      signal?.throwIfAborted();
      const path = join(outputDir, cutFileNames[index]!);
      await maybeMkDeepOutDir({ outputDir, fileOutPath: path });
      const cleanupPaths: string[] = [];
      const effectiveRange = !isEncoding && compatibleTimings?.[index] == null
        ? getLosslessCutRange({ cutFrom: segment.start, cutTo: segment.end, fileDuration, frameDuration: getFrameDuration(detectedFps), cutFromAdjustmentFrames, cutToAdjustmentFrames })
        : segment;
      const originalSources: VerificationSource[] = copyFileStreams.filter((source) => source.streamIds.length > 0).map((source) => ({ path: source.path, streamIds: source.streamIds, start: effectiveRange.start, end: effectiveRange.end }));
      const selectedStreams = copyFileStreams.flatMap((source) => source.streamIds.map((streamId) => allFilesMeta[source.path]!.streams.find((stream) => stream.index === streamId)!));
      const { cuttingStart, cuttingEnd } = getLosslessCutRange({ cutFrom: segment.start, cutTo: segment.end, fileDuration, frameDuration: getFrameDuration(detectedFps), cutFromAdjustmentFrames, cutToAdjustmentFrames });
      const conversionVerification = getStreamConversionVerification(getMapStreamsArgs({ copyFileStreams, allFilesMeta, outFormat, needFlac: (!isEncoding || compatibleTimings?.[index] != null) && (cuttingStart || cuttingEnd) }), selectedStreams);
      const verificationOptions = { ...conversionVerification, timeScale: outputPlaybackRate, preserveTrackMetadata: preserveMetadata !== 'none' && paramsByFile.size === 0 };
      const outcome = await writeValidatedOutput({
        path,
        overwrite: enableOverwriteOutput,
        merged: false,
        reencodedVideo: (result: Awaited<ReturnType<typeof cutSegmentFile>>) => result.reencodedVideo,
        verificationOptions,
        onVerification,
        signal,
        sources: originalSources,
        write: (candidate) => cutSegmentFile(segment, index, candidate, cleanupPaths, compatibleTimings?.[index]),
      });
      if (outcome.status === 'created') await tryDeleteFiles(cleanupPaths);
      if (outcome.status === 'skipped' && verifySkipped) await validateOutput({ path, sources: originalSources, merged: false, reencodedVideo: isEncoding && compatibleTimings?.[index] == null, signal, onVerification, verificationOptions });
      return { path, created: outcome.status === 'created', validated: outcome.status === 'created' || verifySkipped, originalSources };
    };
    try {
      return await pMap(segments, cutSegment, { concurrency: 1 });
    } finally {
      if (chaptersPath) await tryDeleteFiles([chaptersPath]);
    }
  }, [allowWholeSegmentEncode, enableOverwriteOutput, isEncoding, filePath, lossyMode, losslessCutSingle, cutEncodeSmartPart, encCustomBitrate, concatFiles, appendFfmpegCommandLog, outputPlaybackRate, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, cutFromAdjustmentFrames, cutToAdjustmentFrames]);

  const concatCutSegments = useCallback(async ({ customOutDir, outFormat, segmentPaths, ffmpegExperimental, onProgress, preserveMovData, movFastStart, chapterNames, preserveMetadataOnMerge, mergedOutFilePath, onVerification, signal, segmentSources, segmentDurations }: {
    segmentDurations?: number[] | undefined,
    segmentSources?: VerificationSource[] | undefined,
    signal?: AbortSignal | undefined,
    onVerification?: VerificationPhase | undefined,
    customOutDir: string | undefined,
    outFormat: string | undefined,
    segmentPaths: string[],
    ffmpegExperimental: boolean,
    onProgress: (p: number) => void,
    preserveMovData: boolean,
    movFastStart: boolean,
    chapterNames: (string | undefined)[] | undefined,
    preserveMetadataOnMerge: boolean,
    mergedOutFilePath: string,
  }) => {
    signal?.throwIfAborted();
    const outDir = getOutDir(customOutDir, filePath);

    if (await shouldSkipExistingFile(mergedOutFilePath)) return { status: 'skipped' as const, validated: false };

    const readMetadata = createFileMetadataReader(signal);
    const chapters = await createChaptersFromSegments({ paths: segmentPaths, defaultChapterNames: chapterNames, readMetadata });
    signal?.throwIfAborted();

    const metadataFromPath = segmentPaths[0];
    invariant(metadataFromPath != null);
    // need to re-read streams because may have changed
    const { streams } = await readMetadata(metadataFromPath);
    signal?.throwIfAborted();
    return concatFiles({ paths: segmentPaths, outDir, outPath: mergedOutFilePath, metadataFromPath, outFormat, includeAllStreams: true, streams, ffmpegExperimental, onProgress, preserveMovData, movFastStart, chapters, preserveMetadataOnMerge, onVerification, readMetadata, signal, verificationSources: segmentSources, certifiedDurations: segmentDurations });
  }, [concatFiles, filePath, shouldSkipExistingFile]);

  // This is just used to load something into the player with correct duration,
  // so that the user can seek and then we render frames using ffmpeg & MediaSource
  const html5ifyDummy = useCallback(async ({ filePath: filePathArg, outPath, onProgress }: {
    filePath: string,
    outPath: string,
    onProgress: (p: number) => void,
  }) => {
    console.log('Making ffmpeg-assisted dummy file', { filePathArg, outPath });

    const duration = await getDuration(filePathArg);

    const ffmpegArgs = [
      '-hide_banner',

      // This is just a fast way of generating an empty dummy file
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', String(duration),
      '-acodec', 'flac',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });
    logStdoutStderr(result);

    await transferTimestamps({ inPath: filePathArg, outPath, duration, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart });
  }, [appendFfmpegCommandLog, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  const html5ify = useCallback(async ({ customOutDir, filePath: filePathArg, speed, hasAudio, hasVideo, onProgress }: {
    customOutDir: string | undefined,
    filePath: string,
    speed: Html5ifyMode,
    hasAudio: boolean,
    hasVideo: boolean,
    onProgress: (p: number) => void,
  }) => {
    console.log('html5ifyAndLoad', { speed, hasVideo, hasAudio });

    if (speed === 'fastest') {
      const path = getSuffixedOutPath({ customOutDir, filePath: filePathArg, nameSuffix: `${html5ifiedPrefix}${html5dummySuffix}.mkv` });
      await html5ifyDummy({ filePath: filePathArg, outPath: path, onProgress });
      return path;
    }

    const outPath = getHtml5ifiedPath(customOutDir, filePathArg, speed);
    invariant(outPath != null);

    let audio: 'hq' | 'lq' | 'copy' | undefined;
    if (hasAudio) {
      if (speed === 'slowest') audio = 'hq';
      else if (['slow-audio', 'fast-audio'].includes(speed)) audio = 'lq';
      else if (['fast-audio-remux'].includes(speed)) audio = 'copy';
    }

    let video: 'hq' | 'lq' | 'copy' | undefined;
    if (hasVideo) {
      if (speed === 'slowest') video = 'hq';
      else if (['slow-audio', 'slow'].includes(speed)) video = 'lq';
      else video = 'copy';
    }

    console.log('Making HTML5 friendly version', { filePathArg, outPath, speed, video, audio });

    let videoArgs: string[];
    let audioArgs: string[];

    // h264/aac_at: No licensing when using HW encoder (Video/Audio Toolbox on Mac)
    // https://github.com/mifi/lossless-cut/issues/372#issuecomment-810766512

    switch (video) {
      case 'hq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          videoArgs = ['-vf', 'format=yuv420p', '-allow_sw', '1', '-vcodec', 'h264', '-b:v', '15M'];
        } else {
          // AV1 is very slow
          // videoArgs = ['-vf', 'format=yuv420p', '-sws_flags', 'neighbor', '-vcodec', 'libaom-av1', '-crf', '30', '-cpu-used', '8'];
          // Theora is a bit faster but not that much
          // videoArgs = ['-vf', '-c:v', 'libtheora', '-qscale:v', '1'];
          // videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1'];
          // x264 can only be used in GPL projects
          videoArgs = ['-vf', 'format=yuv420p', '-c:v', 'libx264', '-profile:v', 'high', '-preset:v', 'slow', '-crf', '17'];
        }
        break;
      }
      case 'lq': {
        const targetHeight = 400;

        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-allow_sw', '1', '-sws_flags', 'lanczos', '-vcodec', 'h264', '-b:v', '1500k'];
        } else {
          // videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-sws_flags', 'neighbor', '-c:v', 'libtheora', '-qscale:v', '1'];
          // x264 can only be used in GPL projects
          videoArgs = ['-vf', `scale=-2:${targetHeight},format=yuv420p`, '-sws_flags', 'neighbor', '-c:v', 'libx264', '-profile:v', 'baseline', '-x264opts', 'level=3.0', '-preset:v', 'ultrafast', '-crf', '28'];
        }
        break;
      }
      case 'copy': {
        videoArgs = ['-vcodec', 'copy'];
        break;
      }
      default: {
        videoArgs = ['-vn'];
      }
    }

    switch (audio) {
      case 'hq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          audioArgs = ['-acodec', 'aac_at', '-b:a', '192k'];
        } else {
          audioArgs = ['-acodec', 'flac'];
        }
        break;
      }
      case 'lq': {
        // eslint-disable-next-line unicorn/prefer-ternary
        if (isMac) {
          audioArgs = ['-acodec', 'aac_at', '-ar', '44100', '-ac', '2', '-b:a', '96k'];
        } else {
          audioArgs = ['-acodec', 'flac', '-ar', '11025', '-ac', '2'];
        }
        break;
      }
      case 'copy': {
        audioArgs = ['-acodec', 'copy'];
        break;
      }
      default: {
        audioArgs = ['-an'];
      }
    }

    // Some files (e.g. DV/DVCPRO .mov) have an audio channel layout that ffmpeg cannot resample or
    // downmix, which makes the encode fail. Relabel the channels first so that it can.
    // We don't pass -map, so ffmpeg picks one audio stream by itself. Therefore only apply the filter
    // when every audio stream has the same channel count, or the filter might not match the picked stream.
    let audioFilterArgs: string[] = [];
    if (audio != null && audio !== 'copy') {
      try {
        const audioStreams = (await readFileFfprobeMeta(filePathArg)).streams.filter((s) => s.codec_type === 'audio');
        const unsupportedStream = audioStreams.find((s) => hasCustomChannelLayout(s.channel_layout));
        const sameChannelCount = new Set(audioStreams.map((s) => s.channels)).size === 1;
        if (unsupportedStream != null && sameChannelCount) {
          const filter = getFixChannelLayoutFilter({ channels: unsupportedStream.channels, channelLayout: unsupportedStream.channel_layout });
          if (filter != null) audioFilterArgs = ['-af', filter];
        }
      } catch (err) {
        // don't fail the conversion just because we couldn't probe it
        console.warn('Failed to probe audio channel layout', err);
      }
    }

    const ffmpegArgs = [
      '-hide_banner',
      ...((video === 'lq' || video === 'hq') ? getHwaccelArgs(ffmpegHwaccel) : []),

      '-i', filePathArg,
      ...videoArgs,
      ...audioArgs,
      ...audioFilterArgs,
      '-sn',
      '-y', outPath,
    ];

    const duration = await getDuration(filePathArg);
    appendFfmpegCommandLog(ffmpegArgs);
    const { stdout } = await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress });

    console.log(new TextDecoder().decode(stdout));

    invariant(outPath != null);
    await transferTimestamps({ inPath: filePathArg, outPath, duration, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart });
    return outPath;
  }, [appendFfmpegCommandLog, ffmpegHwaccel, html5ifyDummy, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart]);

  // https://stackoverflow.com/questions/34118013/how-to-determine-webm-duration-using-ffprobe
  const fixInvalidDuration = useCallback(async ({ filePath: filePathArg, outPath, onProgress }: {
    filePath: string,
    outPath: string,
    onProgress: (a: number) => void,
  }) => {
    const ffmpegArgs = [
      '-hide_banner',

      '-i', filePathArg,

      // https://github.com/mifi/lossless-cut/issues/1415
      '-map_metadata', '0',
      '-map', '0',
      '-ignore_unknown',

      '-c', 'copy',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpegWithProgress({ ffmpegArgs, onProgress });
    logStdoutStderr(result);

    return outPath;
  }, [appendFfmpegCommandLog]);

  // https://github.com/mifi/lossless-cut/issues/2111
  const decimate = useCallback(async ({ filePath: filePathArg, outPath, n, fps }: {
    n: number,
    fps: number,
    filePath: string,
    outPath: string,
  }) => {
    const ffmpegArgs = [
      '-hide_banner',

      // https://stackoverflow.com/questions/73710657/remove-all-non-keyframes-from-h-264-avc-video-without-re-encoding
      // https://stackoverflow.com/questions/67088473/remove-all-non-key-frames-from-video-without-re-encoding
      // '-discard', 'nokey', // doesn't seem to work with hevc, so use noise=drop=not(key) instead
      // https://chatgpt.com/share/6a1c3be1-1064-83ec-b5c1-fa91ddf3cde8
      '-i', filePathArg,
      '-map', 'v:0',
      '-c', 'copy',
      '-bsf:v', `noise=drop=not(key),noise=drop='mod(n\\,${formatFfmpegNumber(n)})',setts=ts='N/${formatFfmpegNumber(fps)}/TB_OUT'`,
      '-an',
      '-ignore_unknown',
      '-y', outPath,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const result = await runFfmpeg(ffmpegArgs);
    logStdoutStderr(result);

    return outPath;
  }, [appendFfmpegCommandLog]);

  function getPreferredCodecFormat(stream: LiteFFprobeStream) {
    const map = {
      mp3: { format: 'mp3', ext: 'mp3' },
      opus: { format: 'opus', ext: 'opus' },
      vorbis: { format: 'ogg', ext: 'ogg' },
      h264: { format: 'mp4', ext: 'mp4' },
      hevc: { format: 'mp4', ext: 'mp4' },
      eac3: { format: 'eac3', ext: 'eac3' },

      subrip: { format: 'srt', ext: 'srt' },
      mov_text: { format: 'mp4', ext: 'mp4' },

      m4a: { format: 'ipod', ext: 'm4a' },
      aac: { format: 'adts', ext: 'aac' },
      jpeg: { format: 'image2', ext: 'jpeg' },
      png: { format: 'image2', ext: 'png' },

      // TODO add more
      // TODO allow user to change?
    } as const;

    const match = map[stream.codec_name as keyof typeof map];
    if (match) return match;

    // default fallbacks:
    if (stream.codec_type === 'video') return { ext: 'mkv', format: 'matroska' } as const;
    if (stream.codec_type === 'audio') return { ext: 'mka', format: 'matroska' } as const;
    if (stream.codec_type === 'subtitle') return { ext: 'mks', format: 'matroska' } as const;
    if (stream.codec_type === 'data') return { ext: 'bin', format: 'data' } as const; // https://superuser.com/questions/1243257/save-data-stream

    return undefined;
  }

  const extractNonAttachmentStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir?: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    if (streams.length === 0) return [];

    const outStreams = streams.flatMap((s) => {
      const format = getPreferredCodecFormat(s);
      const { index } = s;

      if (format == null || index == null) return [];

      return [{
        index,
        codec: s.codec_name || s.codec_tag_string || s.codec_type,
        type: s.codec_type,
        format,
      }];
    });

    // console.log(outStreams);


    let streamArgs: string[] = [];
    const outPaths = await pMap(outStreams, async ({ index, codec, type, format: { format, ext } }) => {
      const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `stream-${index}-${type}-${codec}.${ext}` });
      if (!enableOverwriteOutput && await mainApi.pathExists(outPath)) throw new RefuseOverwriteError();

      streamArgs = [
        ...streamArgs,
        '-map', `0:${index}`, '-c', 'copy', '-f', format, '-y', outPath,
      ];
      return outPath;
    }, { concurrency: 1 });

    const ffmpegArgs = [
      '-hide_banner',

      '-i', filePath,
      ...streamArgs,
    ];

    appendFfmpegCommandLog(ffmpegArgs);
    const { stdout } = await runFfmpeg(ffmpegArgs);
    console.log(new TextDecoder().decode(stdout));

    return outPaths;
  }, [appendFfmpegCommandLog, enableOverwriteOutput, filePath]);

  const extractAttachmentStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir?: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    if (streams.length === 0) return [];

    console.log('Extracting', streams.length, 'attachment streams');

    let streamArgs: string[] = [];
    const outPaths = await pMap(streams, async ({ index, codec_name: codec, codec_type: type }) => {
      const ext = codec || 'bin';
      const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `stream-${index}-${type}-${codec}.${ext}` });
      invariant(outPath != null);
      if (!enableOverwriteOutput && await mainApi.pathExists(outPath)) throw new RefuseOverwriteError();

      streamArgs = [
        ...streamArgs,
        `-dump_attachment:${index}`, outPath,
      ];
      return outPath;
    }, { concurrency: 1 });

    const ffmpegArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      ...streamArgs,
      '-i', filePath,
    ];

    try {
      appendFfmpegCommandLog(ffmpegArgs);
      const { stdout } = await runFfmpeg(ffmpegArgs);
      console.log(new TextDecoder().decode(stdout));
    } catch (err) {
      // Unfortunately ffmpeg will exit with code 1 even though it's a success
      // Note: This is kind of hacky:
      if (err instanceof Error && 'exitCode' in err && 'stderr' in err && isExpectedAttachmentExit(err.exitCode, err.stderr) && (await Promise.all(outPaths.map((path) => mainApi.pathExists(path)))).every(Boolean)) return outPaths;
      throw err;
    }
    return outPaths;
  }, [appendFfmpegCommandLog, enableOverwriteOutput, filePath]);

  // https://stackoverflow.com/questions/32922226/extract-every-audio-and-subtitles-from-a-video-with-ffmpeg
  const extractStreams = useCallback(async ({ customOutDir, streams }: {
    customOutDir: string | undefined, streams: FFprobeStream[],
  }) => {
    invariant(filePath != null);
    await assertFileExists(filePath);

    const attachmentStreams = streams.filter((s) => s.codec_type === 'attachment');
    const nonAttachmentStreams = streams.filter((s) => s.codec_type !== 'attachment');

    // TODO progress

    // Attachment streams are handled differently from normal streams
    return [
      ...(await extractNonAttachmentStreams({ customOutDir, streams: nonAttachmentStreams })),
      ...(await extractAttachmentStreams({ customOutDir, streams: attachmentStreams })),
    ];
  }, [extractAttachmentStreams, extractNonAttachmentStreams, filePath]);

  return {
    cutMultiple, concatFiles, html5ify, html5ifyDummy, fixInvalidDuration, decimate, concatCutSegments, extractStreams, tryDeleteFiles,
  };
}

export default useFfmpegOperations;

export type FfmpegOperations = ReturnType<typeof useFfmpegOperations>;
