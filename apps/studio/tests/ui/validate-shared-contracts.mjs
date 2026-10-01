import { readFile } from "node:fs/promises";
import { collaborationRealtimeCursorSchema } from "@koed/shared/collaboration";

const cursorFixture = JSON.parse(
  await readFile(
    new URL("./fixtures/realtime-cursor.json", import.meta.url),
    "utf8"
  )
);
const parsedCursor = collaborationRealtimeCursorSchema.safeParse(
  cursorFixture.cursor
);
if (!parsedCursor.success) {
  throw new Error(
    "Synthetic realtime cursor does not match the shared contract."
  );
}
