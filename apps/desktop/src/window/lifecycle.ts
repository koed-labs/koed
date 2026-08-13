export const shouldQuitAfterAllWindowsClosed = (
  platform: NodeJS.Platform
): boolean => platform !== "darwin" && platform !== "linux";

export interface DesktopWindowHandle {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
}

export const createDesktopWindowActivator = (input: {
  createWindow: () => Promise<void>;
  getWindow: () => DesktopWindowHandle | null;
  waitForBootstrap: () => Promise<void>;
}): (() => Promise<void>) => {
  let windowCreation: Promise<void> | null = null;

  return async (): Promise<void> => {
    await input.waitForBootstrap();

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
