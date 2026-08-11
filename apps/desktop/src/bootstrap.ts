import { app } from "electron";
import { formatDesktopStartupError } from "./main/startup-error.js";

const startDesktopMain = async (): Promise<void> => {
  try {
    await import("./main.js");
  } catch (error) {
    const message = formatDesktopStartupError(error);
    console.error(`[koed-desktop] fatal startup failure: ${message}`);
    app.exit(1);
  }
};

process.on("uncaughtException", (error) => {
  console.error(
    `[koed-desktop] fatal uncaught startup failure: ${formatDesktopStartupError(error)}`
  );
  app.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(
    `[koed-desktop] fatal unhandled startup failure: ${formatDesktopStartupError(reason)}`
  );
  app.exit(1);
});

void startDesktopMain();
