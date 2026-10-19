import { useEffect, useState, useRef, useCallback, useMemo, useSyncExternalStore } from 'react';
import i18n from 'i18next';
import type { Transition } from 'motion/react';

import type { Config } from '../../../common/types.js';

import { errorToast } from '../swal';
import isDev from '../isDev';
import { mySpring, emitter as animationsEmitter } from '../animations';
import createSettingsPersistence from './settingsPersistence';

const remote = window.require('@electron/remote');
const { systemPreferences } = remote;
const { configStore } = remote.require('./index.js');

const animationSettings = systemPreferences.getAnimationSettings();
const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
function subscribeSystemDarkMode(onChange: () => void) {
  darkModeMediaQuery.addEventListener('change', onChange);
  return () => darkModeMediaQuery.removeEventListener('change', onChange);
}
const resolveDarkMode = (theme: Config['theme'], systemDarkMode: boolean) => (theme === 'system' ? systemDarkMode : theme === 'dark');

export default function useUserSettingsRoot() {
  const firstUpdateRef = useRef(true);

  const [persistence] = useState(() => createSettingsPersistence<keyof Config, Config[keyof Config]>((key, value) => {
    if (isDev) console.log('save', key, value);
    try {
      configStore.set(key, value);
      return true;
    } catch (err) {
      console.error('Failed to set config', key, err);
      errorToast(i18n.t('Unable to save your preferences. Try to disable any anti-virus'));
      return false;
    }
  }));
  const [interactionRevision, setInteractionRevision] = useState(0);
  const beginSettingsInteraction = useCallback((key: keyof Config) => persistence.begin(key), [persistence]);
  const endSettingsInteraction = useCallback((key: keyof Config) => {
    persistence.end(key);
    setInteractionRevision((revision) => revision + 1);
  }, [persistence]);

  const safeSetConfig = useCallback(<T extends keyof Config>(keyValue: Record<T, Config[T]>) => {
    if (firstUpdateRef.current) return;
    const [key, value] = Object.entries(keyValue)[0]!;
    persistence.update(key as T, value as Config[T]);
  }, [persistence]);

  function safeGetConfig<T extends keyof Config>(key: T) {
    const rawVal = configStore.get(key);
    // NOTE: Need to clone any non-primitive in renderer, or it will become very slow
    // I think because Electron is proxying objects over the bridge
    const cloned: typeof rawVal = rawVal === undefined
      ? undefined
      // eslint-disable-next-line unicorn/prefer-structured-clone
      : JSON.parse(JSON.stringify(rawVal));

    return cloned;
  }

  // From https://reactjs.org/docs/hooks-reference.html#lazy-initial-state
  // If the initial state is the result of an expensive computation, you may provide a function instead, which will be executed only on the initial render
  // Without this there was a huge performance issue https://github.com/mifi/lossless-cut/issues/1097
  const safeGetConfigInitial = <T extends keyof Config>(key: T) => () => safeGetConfig(key);

  const [lastAppVersion, setLastAppVersion] = useState(safeGetConfigInitial('lastAppVersion'));
  useEffect(() => safeSetConfig({ lastAppVersion }), [lastAppVersion, safeSetConfig]);
  const [captureFormat, setCaptureFormat] = useState(safeGetConfigInitial('captureFormat'));
  useEffect(() => safeSetConfig({ captureFormat }), [captureFormat, safeSetConfig]);
  const [recentCustomOutDirs, setRecentCustomOutDirs] = useState(safeGetConfigInitial('recentCustomOutDirs'));
  useEffect(() => safeSetConfig({ recentCustomOutDirs }), [recentCustomOutDirs, safeSetConfig]);
  const [enableCustomOutDir, setEnableCustomOutDir] = useState(safeGetConfigInitial('enableCustomOutDir'));
  useEffect(() => safeSetConfig({ enableCustomOutDir }), [enableCustomOutDir, safeSetConfig]);
  const [keyframeCut, setKeyframeCut] = useState(safeGetConfigInitial('keyframeCut'));
  useEffect(() => safeSetConfig({ keyframeCut }), [keyframeCut, safeSetConfig]);
  const [preserveMetadata, setPreserveMetadata] = useState(safeGetConfigInitial('preserveMetadata'));
  useEffect(() => safeSetConfig({ preserveMetadata }), [preserveMetadata, safeSetConfig]);
  const [preserveMetadataOnMerge, setPreserveMetadataOnMerge] = useState(safeGetConfigInitial('preserveMetadataOnMerge'));
  useEffect(() => safeSetConfig({ preserveMetadataOnMerge }), [preserveMetadataOnMerge, safeSetConfig]);
  const [preserveMovData, setPreserveMovData] = useState(safeGetConfigInitial('preserveMovData'));
  useEffect(() => safeSetConfig({ preserveMovData }), [preserveMovData, safeSetConfig]);
  const [preserveChapters, setPreserveChapters] = useState(safeGetConfigInitial('preserveChapters'));
  useEffect(() => safeSetConfig({ preserveChapters }), [preserveChapters, safeSetConfig]);
  const [movFastStart, setMovFastStart] = useState(safeGetConfigInitial('movFastStart'));
  useEffect(() => safeSetConfig({ movFastStart }), [movFastStart, safeSetConfig]);
  const [avoidNegativeTs, setAvoidNegativeTs] = useState(safeGetConfigInitial('avoidNegativeTs'));
  useEffect(() => safeSetConfig({ avoidNegativeTs }), [avoidNegativeTs, safeSetConfig]);
  const [autoMerge, setAutoMerge] = useState(safeGetConfigInitial('autoMerge'));
  useEffect(() => safeSetConfig({ autoMerge }), [autoMerge, safeSetConfig]);
  const [timecodeFormat, setTimecodeFormat] = useState(safeGetConfigInitial('timecodeFormat'));
  useEffect(() => safeSetConfig({ timecodeFormat }), [timecodeFormat, safeSetConfig]);
  const [invertCutSegments, setInvertCutSegments] = useState(safeGetConfigInitial('invertCutSegments'));
  useEffect(() => safeSetConfig({ invertCutSegments }), [invertCutSegments, safeSetConfig]);
  const [autoExportExtraStreams, setAutoExportExtraStreams] = useState(safeGetConfigInitial('autoExportExtraStreams'));
  useEffect(() => safeSetConfig({ autoExportExtraStreams }), [autoExportExtraStreams, safeSetConfig]);
  const [askBeforeClose, setAskBeforeClose] = useState(safeGetConfigInitial('askBeforeClose'));
  useEffect(() => safeSetConfig({ askBeforeClose }), [askBeforeClose, safeSetConfig]);
  const [enableImportChapters, setEnableImportChapters] = useState(safeGetConfigInitial('enableImportChapters'));
  useEffect(() => safeSetConfig({ enableImportChapters }), [enableImportChapters, safeSetConfig]);
  const [enableAskForFileOpenAction, setEnableAskForFileOpenAction] = useState(safeGetConfigInitial('enableAskForFileOpenAction'));
  useEffect(() => safeSetConfig({ enableAskForFileOpenAction }), [enableAskForFileOpenAction, safeSetConfig]);
  const [playbackVolume, setPlaybackVolume] = useState(safeGetConfigInitial('playbackVolume'));
  useEffect(() => safeSetConfig({ playbackVolume }), [playbackVolume, safeSetConfig]);
  const [autoSaveProjectFile, setAutoSaveProjectFile] = useState(safeGetConfigInitial('autoSaveProjectFile'));
  useEffect(() => safeSetConfig({ autoSaveProjectFile }), [autoSaveProjectFile, safeSetConfig]);
  const [wheelSensitivity, setWheelSensitivity] = useState(safeGetConfigInitial('wheelSensitivity'));
  useEffect(() => safeSetConfig({ wheelSensitivity }), [wheelSensitivity, safeSetConfig]);
  const [waveformHeight, setWaveformHeight] = useState(safeGetConfigInitial('waveformHeight'));
  useEffect(() => safeSetConfig({ waveformHeight }), [waveformHeight, safeSetConfig]);
  const [invertTimelineScroll, setInvertTimelineScroll] = useState(safeGetConfigInitial('invertTimelineScroll'));
  useEffect(() => safeSetConfig({ invertTimelineScroll }), [invertTimelineScroll, safeSetConfig]);
  const [language, setLanguage] = useState(safeGetConfigInitial('language'));
  useEffect(() => safeSetConfig({ language }), [language, safeSetConfig]);
  const [ffmpegExperimental, setFfmpegExperimental] = useState(safeGetConfigInitial('ffmpegExperimental'));
  useEffect(() => safeSetConfig({ ffmpegExperimental }), [ffmpegExperimental, safeSetConfig]);
  const [hideNotifications, setHideNotifications] = useState(safeGetConfigInitial('hideNotifications'));
  useEffect(() => safeSetConfig({ hideNotifications }), [hideNotifications, safeSetConfig]);
  const [hideOsNotifications, setHideOsNotifications] = useState(safeGetConfigInitial('hideOsNotifications'));
  useEffect(() => safeSetConfig({ hideOsNotifications }), [hideOsNotifications, safeSetConfig]);
  const [autoLoadTimecode, setAutoLoadTimecode] = useState(safeGetConfigInitial('autoLoadTimecode'));
  useEffect(() => safeSetConfig({ autoLoadTimecode }), [autoLoadTimecode, safeSetConfig]);
  const [autoDeleteMergedSegments, setAutoDeleteMergedSegments] = useState(safeGetConfigInitial('autoDeleteMergedSegments'));
  useEffect(() => safeSetConfig({ autoDeleteMergedSegments }), [autoDeleteMergedSegments, safeSetConfig]);
  const [exportConfirmEnabled, setExportConfirmEnabled] = useState(safeGetConfigInitial('exportConfirmEnabled'));
  useEffect(() => safeSetConfig({ exportConfirmEnabled }), [exportConfirmEnabled, safeSetConfig]);
  const [segmentsToChapters, setSegmentsToChapters] = useState(safeGetConfigInitial('segmentsToChapters'));
  useEffect(() => safeSetConfig({ segmentsToChapters }), [segmentsToChapters, safeSetConfig]);
  const [simpleMode, setSimpleMode] = useState(safeGetConfigInitial('simpleMode'));
  useEffect(() => safeSetConfig({ simpleMode }), [simpleMode, safeSetConfig]);
  const [cutFileTemplate, setCutFileTemplate] = useState(safeGetConfigInitial('outSegTemplate'));
  useEffect(() => safeSetConfig({ outSegTemplate: cutFileTemplate }), [cutFileTemplate, safeSetConfig]);
  const [cutMergedFileTemplate, setCutMergedFileTemplate] = useState(safeGetConfigInitial('mergedFileTemplate'));
  useEffect(() => safeSetConfig({ mergedFileTemplate: cutMergedFileTemplate }), [cutMergedFileTemplate, safeSetConfig]);
  const [mergedFileTemplate, setMergedFileTemplate] = useState(safeGetConfigInitial('mergedFilesTemplate'));
  useEffect(() => safeSetConfig({ mergedFilesTemplate: mergedFileTemplate }), [mergedFileTemplate, safeSetConfig]);
  const [keyboardSeekAccFactor, setKeyboardSeekAccFactor] = useState(safeGetConfigInitial('keyboardSeekAccFactor'));
  useEffect(() => safeSetConfig({ keyboardSeekAccFactor }), [keyboardSeekAccFactor, safeSetConfig]);
  const [keyboardNormalSeekSpeed, setKeyboardNormalSeekSpeed] = useState(safeGetConfigInitial('keyboardNormalSeekSpeed'));
  useEffect(() => safeSetConfig({ keyboardNormalSeekSpeed }), [keyboardNormalSeekSpeed, safeSetConfig]);
  const [keyboardSeekSpeed2, setKeyboardSeekSpeed2] = useState(safeGetConfigInitial('keyboardSeekSpeed2'));
  useEffect(() => safeSetConfig({ keyboardSeekSpeed2 }), [keyboardSeekSpeed2, safeSetConfig]);
  const [keyboardSeekSpeed3, setKeyboardSeekSpeed3] = useState(safeGetConfigInitial('keyboardSeekSpeed3'));
  useEffect(() => safeSetConfig({ keyboardSeekSpeed3 }), [keyboardSeekSpeed3, safeSetConfig]);

  const [treatInputFileModifiedTimeAsStart, setTreatInputFileModifiedTimeAsStart] = useState(safeGetConfigInitial('treatInputFileModifiedTimeAsStart'));
  useEffect(() => safeSetConfig({ treatInputFileModifiedTimeAsStart }), [treatInputFileModifiedTimeAsStart, safeSetConfig]);
  const [treatOutputFileModifiedTimeAsStart, setTreatOutputFileModifiedTimeAsStart] = useState(safeGetConfigInitial('treatOutputFileModifiedTimeAsStart'));
  useEffect(() => safeSetConfig({ treatOutputFileModifiedTimeAsStart }), [treatOutputFileModifiedTimeAsStart, safeSetConfig]);

  const [outFormatLocked, setOutFormatLocked] = useState(safeGetConfigInitial('outFormatLocked'));
  useEffect(() => safeSetConfig({ outFormatLocked }), [outFormatLocked, safeSetConfig]);
  const [safeOutputFileName, setSafeOutputFileName] = useState(safeGetConfigInitial('safeOutputFileName'));
  useEffect(() => safeSetConfig({ safeOutputFileName }), [safeOutputFileName, safeSetConfig]);
  const [enableAutoHtml5ify, setEnableAutoHtml5ify] = useState(safeGetConfigInitial('enableAutoHtml5ify'));
  useEffect(() => safeSetConfig({ enableAutoHtml5ify }), [enableAutoHtml5ify, safeSetConfig]);
  const [segmentsToChaptersOnly, setSegmentsToChaptersOnly] = useState(safeGetConfigInitial('segmentsToChaptersOnly'));
  useEffect(() => safeSetConfig({ segmentsToChaptersOnly }), [segmentsToChaptersOnly, safeSetConfig]);
  const [keyBindings, setKeyBindings] = useState(safeGetConfigInitial('keyBindings'));
  useEffect(() => safeSetConfig({ keyBindings }), [keyBindings, safeSetConfig]);
  const [enableSmartCut, setEnableSmartCut] = useState(safeGetConfigInitial('enableSmartCut'));
  useEffect(() => safeSetConfig({ enableSmartCut }), [enableSmartCut, safeSetConfig]);
  const [customFfPath, setCustomFfPath] = useState(safeGetConfigInitial('customFfPath'));
  useEffect(() => safeSetConfig({ customFfPath }), [customFfPath, safeSetConfig]);
  const [storeProjectInWorkingDir, setStoreProjectInWorkingDir] = useState(safeGetConfigInitial('storeProjectInWorkingDir'));
  useEffect(() => safeSetConfig({ storeProjectInWorkingDir }), [storeProjectInWorkingDir, safeSetConfig]);
  const [enableOverwriteOutput, setEnableOverwriteOutput] = useState(safeGetConfigInitial('enableOverwriteOutput'));
  useEffect(() => safeSetConfig({ enableOverwriteOutput }), [enableOverwriteOutput, safeSetConfig]);
  const [mouseWheelZoomModifierKey, setMouseWheelZoomModifierKey] = useState(safeGetConfigInitial('mouseWheelZoomModifierKey'));
  useEffect(() => safeSetConfig({ mouseWheelZoomModifierKey }), [mouseWheelZoomModifierKey, safeSetConfig]);
  const [mouseWheelFrameSeekModifierKey, setMouseWheelFrameSeekModifierKey] = useState(safeGetConfigInitial('mouseWheelFrameSeekModifierKey'));
  useEffect(() => safeSetConfig({ mouseWheelFrameSeekModifierKey }), [mouseWheelFrameSeekModifierKey, safeSetConfig]);
  const [mouseWheelKeyframeSeekModifierKey, setMouseWheelKeyframeSeekModifierKey] = useState(safeGetConfigInitial('mouseWheelKeyframeSeekModifierKey'));
  useEffect(() => safeSetConfig({ mouseWheelKeyframeSeekModifierKey }), [mouseWheelKeyframeSeekModifierKey, safeSetConfig]);
  const [segmentMouseModifierKey, setSegmentMouseModifierKey] = useState(safeGetConfigInitial('segmentMouseModifierKey'));
  useEffect(() => safeSetConfig({ segmentMouseModifierKey }), [segmentMouseModifierKey, safeSetConfig]);
  const [captureFrameMethod, setCaptureFrameMethod] = useState(safeGetConfigInitial('captureFrameMethod'));
  useEffect(() => safeSetConfig({ captureFrameMethod }), [captureFrameMethod, safeSetConfig]);
  const [captureFrameQuality, setCaptureFrameQuality] = useState(safeGetConfigInitial('captureFrameQuality'));
  useEffect(() => safeSetConfig({ captureFrameQuality }), [captureFrameQuality, safeSetConfig]);
  const [captureFrameFileNameFormat, setCaptureFrameFileNameFormat] = useState(safeGetConfigInitial('captureFrameFileNameFormat'));
  useEffect(() => safeSetConfig({ captureFrameFileNameFormat }), [captureFrameFileNameFormat, safeSetConfig]);
  const [enableNativeHevc, setEnableNativeHevc] = useState(safeGetConfigInitial('enableNativeHevc'));
  useEffect(() => safeSetConfig({ enableNativeHevc }), [enableNativeHevc, safeSetConfig]);
  const [enableUpdateCheck, setEnableUpdateCheck] = useState(safeGetConfigInitial('enableUpdateCheck'));
  useEffect(() => safeSetConfig({ enableUpdateCheck }), [enableUpdateCheck, safeSetConfig]);
  const [cleanupChoices, setCleanupChoices] = useState(safeGetConfigInitial('cleanupChoices'));
  useEffect(() => safeSetConfig({ cleanupChoices }), [cleanupChoices, safeSetConfig]);
  const [allowMultipleInstances, setAllowMultipleInstances] = useState(safeGetConfigInitial('allowMultipleInstances'));
  useEffect(() => safeSetConfig({ allowMultipleInstances }), [allowMultipleInstances, safeSetConfig]);
  const [theme, setTheme] = useState(safeGetConfigInitial('theme'));
  useEffect(() => safeSetConfig({ theme }), [theme, safeSetConfig]);
  const [videoFit, setVideoFit] = useState(safeGetConfigInitial('videoFit'));
  useEffect(() => safeSetConfig({ videoFit }), [videoFit, safeSetConfig]);
  const [preferStrongColors, setPreferStrongColors] = useState(safeGetConfigInitial('preferStrongColors'));
  useEffect(() => safeSetConfig({ preferStrongColors }), [preferStrongColors, safeSetConfig]);
  const [outputFileNameMinZeroPadding, setOutputFileNameMinZeroPadding] = useState(safeGetConfigInitial('outputFileNameMinZeroPadding'));
  useEffect(() => safeSetConfig({ outputFileNameMinZeroPadding }), [outputFileNameMinZeroPadding, safeSetConfig]);
  const [cutFromAdjustmentFrames, setCutFromAdjustmentFrames] = useState(safeGetConfigInitial('cutFromAdjustmentFrames'));
  useEffect(() => safeSetConfig({ cutFromAdjustmentFrames }), [cutFromAdjustmentFrames, safeSetConfig]);
  const [cutToAdjustmentFrames, setCutToAdjustmentFrames] = useState(safeGetConfigInitial('cutToAdjustmentFrames'));
  useEffect(() => safeSetConfig({ cutToAdjustmentFrames }), [cutToAdjustmentFrames, safeSetConfig]);
  const [storeWindowBounds, setStoreWindowBounds] = useState(safeGetConfigInitial('storeWindowBounds'));
  useEffect(() => safeSetConfig({ storeWindowBounds }), [storeWindowBounds, safeSetConfig]);
  const [waveformMode, setWaveformMode] = useState(safeGetConfigInitial('waveformMode'));
  useEffect(() => safeSetConfig({ waveformMode }), [waveformMode, safeSetConfig]);
  const [thumbnailsEnabled, setThumbnailsEnabled] = useState(safeGetConfigInitial('thumbnailsEnabled'));
  useEffect(() => safeSetConfig({ thumbnailsEnabled }), [thumbnailsEnabled, safeSetConfig]);
  const [keyframesEnabled, setKeyframesEnabled] = useState(safeGetConfigInitial('keyframesEnabled'));
  useEffect(() => safeSetConfig({ keyframesEnabled }), [keyframesEnabled, safeSetConfig]);
  const [reducedMotion, setReducedMotion] = useState(safeGetConfigInitial('reducedMotion'));
  useEffect(() => safeSetConfig({ reducedMotion }), [reducedMotion, safeSetConfig]);
  const [ffmpegHwaccel, setFfmpegHwaccel] = useState(safeGetConfigInitial('ffmpegHwaccel'));
  useEffect(() => safeSetConfig({ ffmpegHwaccel }), [ffmpegHwaccel, safeSetConfig]);


  const resetKeyBindings = useCallback(() => {
    configStore.reset('keyBindings');
    setKeyBindings(safeGetConfig('keyBindings'));
  }, []);

  // NOTE! This useEffect must be placed after all usages of firstUpdateRef.current (safeSetConfig)
  useEffect(() => {
    firstUpdateRef.current = false;
    return () => {
      firstUpdateRef.current = true;
    };
  }, []);

  // Flush after preference effects have captured the final render of the interaction.
  useEffect(() => persistence.flush(), [persistence, interactionRevision]);
  useEffect(() => {
    const flush = () => persistence.flush(true);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [persistence]);

  // note: main sets nativeTheme.themeSource from `theme`, and it must be 'system' for prefers-color-scheme to report the OS theme
  const systemDarkMode = useSyncExternalStore(subscribeSystemDarkMode, () => darkModeMediaQuery.matches);

  const darkMode = resolveDarkMode(theme, systemDarkMode);

  const toggleDarkMode = useCallback(() => setTheme((t) => (resolveDarkMode(t, darkModeMediaQuery.matches) ? 'light' : 'dark')), []);

  const prefersReducedMotion = useMemo(() => {
    if (reducedMotion !== 'user') return reducedMotion === 'always';
    // fallback to electron detected system setting
    // note: user has to restart app for changes here to be detected
    return animationSettings.prefersReducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    animationsEmitter.emit('reducedMotion', prefersReducedMotion);
  }, [prefersReducedMotion]);

  const springAnimation = useMemo<Transition>(() => (prefersReducedMotion ? { duration: 0 } : mySpring), [prefersReducedMotion]);

  const customOutDir = useMemo(() => (enableCustomOutDir ? recentCustomOutDirs[0] : undefined), [enableCustomOutDir, recentCustomOutDirs]);

  const setCustomOutDir = useCallback((newDir: string | undefined) => {
    if (newDir) {
      setRecentCustomOutDirs((prev) => [
        newDir,
        ...prev.filter((d) => d !== newDir),
      ].slice(0, 5)); // keep only the 5 most recent dirs
      setEnableCustomOutDir(true);
    } else {
      setEnableCustomOutDir(false);
    }
  }, []);

  // Note: settings are reported when reporting errors
  // 🚨 Must be JSON-serializable!
  const settings = useMemo(() => ({
    lastAppVersion,
    captureFormat,
    recentCustomOutDirs,
    enableCustomOutDir,
    keyframeCut,
    preserveMetadata,
    preserveMetadataOnMerge,
    preserveMovData,
    preserveChapters,
    movFastStart,
    avoidNegativeTs,
    autoMerge,
    timecodeFormat,
    invertCutSegments,
    autoExportExtraStreams,
    askBeforeClose,
    enableImportChapters,
    enableAskForFileOpenAction,
    playbackVolume,
    autoSaveProjectFile,
    wheelSensitivity,
    waveformHeight,
    invertTimelineScroll,
    language,
    ffmpegExperimental,
    hideNotifications,
    hideOsNotifications,
    autoLoadTimecode,
    autoDeleteMergedSegments,
    exportConfirmEnabled,
    segmentsToChapters,
    simpleMode,
    cutFileTemplate,
    cutMergedFileTemplate,
    mergedFileTemplate,
    keyboardSeekAccFactor,
    keyboardNormalSeekSpeed,
    keyboardSeekSpeed2,
    keyboardSeekSpeed3,
    treatInputFileModifiedTimeAsStart,
    treatOutputFileModifiedTimeAsStart,
    outFormatLocked,
    safeOutputFileName,
    enableAutoHtml5ify,
    segmentsToChaptersOnly,
    keyBindings,
    enableSmartCut,
    customFfPath,
    storeProjectInWorkingDir,
    enableOverwriteOutput,
    mouseWheelZoomModifierKey,
    mouseWheelFrameSeekModifierKey,
    mouseWheelKeyframeSeekModifierKey,
    segmentMouseModifierKey,
    captureFrameMethod,
    captureFrameQuality,
    captureFrameFileNameFormat,
    enableNativeHevc,
    enableUpdateCheck,
    cleanupChoices,
    allowMultipleInstances,
    theme,
    videoFit,
    preferStrongColors,
    outputFileNameMinZeroPadding,
    cutFromAdjustmentFrames,
    cutToAdjustmentFrames,
    storeWindowBounds,
    waveformMode,
    thumbnailsEnabled,
    keyframesEnabled,
    reducedMotion,
    ffmpegHwaccel,
  }), [lastAppVersion, captureFormat, recentCustomOutDirs, enableCustomOutDir, keyframeCut, preserveMetadata, preserveMetadataOnMerge, preserveMovData, preserveChapters, movFastStart, avoidNegativeTs, autoMerge, timecodeFormat, invertCutSegments, autoExportExtraStreams, askBeforeClose, enableImportChapters, enableAskForFileOpenAction, playbackVolume, autoSaveProjectFile, wheelSensitivity, waveformHeight, invertTimelineScroll, language, ffmpegExperimental, hideNotifications, hideOsNotifications, autoLoadTimecode, autoDeleteMergedSegments, exportConfirmEnabled, segmentsToChapters, simpleMode, cutFileTemplate, cutMergedFileTemplate, mergedFileTemplate, keyboardSeekAccFactor, keyboardNormalSeekSpeed, keyboardSeekSpeed2, keyboardSeekSpeed3, treatInputFileModifiedTimeAsStart, treatOutputFileModifiedTimeAsStart, outFormatLocked, safeOutputFileName, enableAutoHtml5ify, segmentsToChaptersOnly, keyBindings, enableSmartCut, customFfPath, storeProjectInWorkingDir, enableOverwriteOutput, mouseWheelZoomModifierKey, mouseWheelFrameSeekModifierKey, mouseWheelKeyframeSeekModifierKey, segmentMouseModifierKey, captureFrameMethod, captureFrameQuality, captureFrameFileNameFormat, enableNativeHevc, enableUpdateCheck, cleanupChoices, allowMultipleInstances, theme, videoFit, preferStrongColors, outputFileNameMinZeroPadding, cutFromAdjustmentFrames, cutToAdjustmentFrames, storeWindowBounds, waveformMode, thumbnailsEnabled, keyframesEnabled, reducedMotion, ffmpegHwaccel]);

  return useMemo(() => ({
    settings,
    beginSettingsInteraction,
    endSettingsInteraction,

    springAnimation,
    customOutDir,

    // setters
    setLastAppVersion,
    setCaptureFormat,
    setCustomOutDir,
    setRecentCustomOutDirs,
    setKeyframeCut,
    setPreserveMetadata,
    setPreserveMetadataOnMerge,
    setPreserveMovData,
    setPreserveChapters,
    setMovFastStart,
    setAvoidNegativeTs,
    setAutoMerge,
    setTimecodeFormat,
    setInvertCutSegments,
    setAutoExportExtraStreams,
    setAskBeforeClose,
    setEnableImportChapters,
    setEnableAskForFileOpenAction,
    setPlaybackVolume,
    setAutoSaveProjectFile,
    setWheelSensitivity,
    setWaveformHeight,
    setInvertTimelineScroll,
    setLanguage,
    setFfmpegExperimental,
    setHideNotifications,
    setHideOsNotifications,
    setAutoLoadTimecode,
    setAutoDeleteMergedSegments,
    setExportConfirmEnabled,
    setSegmentsToChapters,
    setSimpleMode,
    setCutFileTemplate,
    setCutMergedFileTemplate,
    setMergedFileTemplate,
    setKeyboardSeekAccFactor,
    setKeyboardNormalSeekSpeed,
    setKeyboardSeekSpeed2,
    setKeyboardSeekSpeed3,
    setTreatInputFileModifiedTimeAsStart,
    setTreatOutputFileModifiedTimeAsStart,
    setOutFormatLocked,
    setSafeOutputFileName,
    setEnableAutoHtml5ify,
    setSegmentsToChaptersOnly,
    setKeyBindings,
    resetKeyBindings,
    setEnableSmartCut,
    setCustomFfPath,
    setStoreProjectInWorkingDir,
    setEnableOverwriteOutput,
    setMouseWheelZoomModifierKey,
    setMouseWheelFrameSeekModifierKey,
    setMouseWheelKeyframeSeekModifierKey,
    setSegmentMouseModifierKey,
    setCaptureFrameMethod,
    setCaptureFrameQuality,
    setCaptureFrameFileNameFormat,
    setEnableNativeHevc,
    setEnableUpdateCheck,
    setCleanupChoices,
    setAllowMultipleInstances,
    darkMode,
    setTheme,
    setVideoFit,
    toggleDarkMode,
    setPreferStrongColors,
    setOutputFileNameMinZeroPadding,
    setCutFromAdjustmentFrames,
    setCutToAdjustmentFrames,
    setStoreWindowBounds,
    setWaveformMode,
    setThumbnailsEnabled,
    setKeyframesEnabled,
    prefersReducedMotion,
    setReducedMotion,
    setFfmpegHwaccel,
  }), [settings, beginSettingsInteraction, endSettingsInteraction, springAnimation, customOutDir, setLastAppVersion, setCaptureFormat, setCustomOutDir, setRecentCustomOutDirs, setKeyframeCut, setPreserveMetadata, setPreserveMetadataOnMerge, setPreserveMovData, setPreserveChapters, setMovFastStart, setAvoidNegativeTs, setAutoMerge, setTimecodeFormat, setInvertCutSegments, setAutoExportExtraStreams, setAskBeforeClose, setEnableImportChapters, setEnableAskForFileOpenAction, setPlaybackVolume, setAutoSaveProjectFile, setWheelSensitivity, setWaveformHeight, setInvertTimelineScroll, setLanguage, setFfmpegExperimental, setHideNotifications, setHideOsNotifications, setAutoLoadTimecode, setAutoDeleteMergedSegments, setExportConfirmEnabled, setSegmentsToChapters, setSimpleMode, setCutFileTemplate, setCutMergedFileTemplate, setMergedFileTemplate, setKeyboardSeekAccFactor, setKeyboardNormalSeekSpeed, setKeyboardSeekSpeed2, setKeyboardSeekSpeed3, setTreatInputFileModifiedTimeAsStart, setTreatOutputFileModifiedTimeAsStart, setOutFormatLocked, setSafeOutputFileName, setEnableAutoHtml5ify, setSegmentsToChaptersOnly, setKeyBindings, resetKeyBindings, setEnableSmartCut, setCustomFfPath, setStoreProjectInWorkingDir, setEnableOverwriteOutput, setMouseWheelZoomModifierKey, setMouseWheelFrameSeekModifierKey, setMouseWheelKeyframeSeekModifierKey, setSegmentMouseModifierKey, setCaptureFrameMethod, setCaptureFrameQuality, setCaptureFrameFileNameFormat, setEnableNativeHevc, setEnableUpdateCheck, setCleanupChoices, setAllowMultipleInstances, darkMode, setTheme, setVideoFit, toggleDarkMode, setPreferStrongColors, setOutputFileNameMinZeroPadding, setCutFromAdjustmentFrames, setCutToAdjustmentFrames, setStoreWindowBounds, setWaveformMode, setThumbnailsEnabled, setKeyframesEnabled, prefersReducedMotion, setReducedMotion, setFfmpegHwaccel]);
}

export type UserSettingsRoot = ReturnType<typeof useUserSettingsRoot>;
