export const startDesktopWindowAndRuntime = async (input: {
  background: boolean;
  createWindow: () => Promise<void>;
  resumeRuntime: () => Promise<unknown>;
  onRuntimeSettled?: () => void;
}): Promise<void> => {
  if (!input.background) await input.createWindow();
  void input
    .resumeRuntime()
    .catch(() => undefined)
    .finally(() => input.onRuntimeSettled?.());
};
