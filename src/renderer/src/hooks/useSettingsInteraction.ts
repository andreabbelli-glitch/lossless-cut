import { useCallback, useEffect, useRef } from 'react';

import type { Config } from '../../../common/types';
import useUserSettings from './useUserSettings';

export default function useSettingsInteraction(key: keyof Config) {
  const { beginSettingsInteraction, endSettingsInteraction } = useUserSettings();
  const active = useRef(false);
  const begin = useCallback(() => {
    if (!active.current) {
      active.current = true;
      beginSettingsInteraction(key);
    }
  }, [beginSettingsInteraction, key]);
  const end = useCallback(() => {
    if (active.current) {
      active.current = false;
      endSettingsInteraction(key);
    }
  }, [endSettingsInteraction, key]);
  useEffect(() => {
    // Releasing outside the control must also commit the final value.
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keyup', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keyup', end);
      window.removeEventListener('blur', end);
      end();
    };
  }, [end]);
  return { onPointerDown: begin, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end, onKeyDown: begin, onKeyUp: end, onBlur: end };
}
