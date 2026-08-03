export const startDesktopWindowAndRuntime = async (input: {
  createWindow: () => Promise<void>;
  resumeRuntime: () => Promise<unknown>;
}): Promise<void> => {
  await input.createWindow();
  void input.resumeRuntime().catch(() => undefined);
};
