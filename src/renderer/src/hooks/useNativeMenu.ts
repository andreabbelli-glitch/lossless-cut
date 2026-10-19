import type { MenuItemConstructorOptions, MenuItem } from 'electron';
import { useCallback, useLayoutEffect, useRef } from 'react';

// TODO pull out?
const { getCurrentWindow, Menu } = window.require('@electron/remote');
// eslint-disable-next-line prefer-destructuring

// https://github.com/transflow/use-electron-context-menu
// https://www.electronjs.org/docs/latest/api/menu-item
export default function useNativeMenu(
  template: (MenuItemConstructorOptions | MenuItem)[],
  options: { x?: number, y?: number, onContext?: (e: MouseEvent) => void, onClose?: () => void } = {},
) {
  const { x, y, onContext, onClose } = options;
  const latest = useRef({ template, x, y, onContext, onClose });
  const menuRef = useRef<ReturnType<typeof Menu.buildFromTemplate>>(undefined);
  useLayoutEffect(() => { latest.current = { template, x, y, onContext, onClose }; }, [template, x, y, onContext, onClose]);

  const openMenu = useCallback((e: MouseEvent) => {
    menuRef.current?.closePopup();
    const { current } = latest;
    const menu = Menu.buildFromTemplate(current.template);
    menuRef.current = menu;
    // @ts-expect-error todo type this
    menu.popup({
      window: getCurrentWindow(),
      x: current.x,
      y: current.y,
      callback: () => {
        if (menuRef.current === menu) menuRef.current = undefined;
        current.onClose?.();
      },
    });

    current.onContext?.(e);
  }, []);

  const closeMenu = useCallback(() => {
    menuRef.current?.closePopup();
    menuRef.current = undefined;
  }, []);

  useLayoutEffect(() => closeMenu, [closeMenu]);

  return { openMenu, closeMenu };
}
