export const createDesktopWindowIfAllowed = async (input: {
  canStart: () => boolean;
  createWindow: () => Promise<void>;
}): Promise<boolean> => {
  if (!input.canStart()) return false;
  await input.createWindow();
  return input.canStart();
};

export const startDesktopWindowAndRuntime = async (input: {
  createWindow: () => Promise<void>;
  resumeRuntime: () => Promise<unknown>;
}): Promise<void> => {
  await input.createWindow();
  void input.resumeRuntime().catch(() => undefined);
};
