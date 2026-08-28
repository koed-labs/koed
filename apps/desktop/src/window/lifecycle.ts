export const shouldQuitAfterAllWindowsClosed = (
  platform: NodeJS.Platform
): boolean => {
  void platform;
  return false;
};

export interface DesktopActivationOutcome {
  backgroundLaunchPending: false;
  openWindow: boolean;
}

export const consumeDesktopActivation = (
  backgroundLaunchPending: boolean
): DesktopActivationOutcome => ({
  backgroundLaunchPending: false,
  openWindow: !backgroundLaunchPending
});

export interface DesktopWindowHandle {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
}

export const createDesktopWindowActivator = (input: {
  beforeOpen?: () => void | Promise<void>;
  createWindow: () => Promise<void>;
  getWindow: () => DesktopWindowHandle | null;
  waitForBootstrap: () => Promise<void>;
}): (() => Promise<void>) => {
  let windowCreation: Promise<void> | null = null;

  return async (): Promise<void> => {
    await input.waitForBootstrap();
    if (input.beforeOpen) await input.beforeOpen();

    const window = input.getWindow();
    if (!window || window.isDestroyed()) {
      if (!windowCreation) {
        const currentCreation = Promise.resolve()
          .then(input.createWindow)
          .finally(() => {
            if (windowCreation === currentCreation) windowCreation = null;
          });
        windowCreation = currentCreation;
      }
      await windowCreation;
      return;
    }

    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
};
