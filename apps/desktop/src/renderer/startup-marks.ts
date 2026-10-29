/**
 * Startup timing marks. Each mark is written once, with milliseconds since
 * the window started loading; the main process copies them to the app log.
 */
const marked = new Set<string>();

export const startupMark = (name: string): void => {
  if (marked.has(name)) return;
  marked.add(name);
  console.info(`[koed-startup] ${name} at ${Math.round(performance.now())} ms`);
};
