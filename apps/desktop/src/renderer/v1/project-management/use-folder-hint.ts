import { useEffect, useState } from "react";
import type { PersonalFolderHint } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";

/** Loads the advisory Folder hints for one Conversation, best first. A
 * failure only hides the suggestion. */
export function useFolderHint(
  api: PersonalDesktopApi,
  sessionId: string,
  enabled: boolean
): PersonalFolderHint[] {
  const [hints, setHints] = useState<PersonalFolderHint[]>([]);
  useEffect(() => {
    if (!enabled || !api.folderHints) return;
    let current = true;
    void api
      .folderHints({ sessionIds: [sessionId] })
      .then((all) => {
        if (current)
          setHints(all.filter((item) => item.sessionId === sessionId));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, sessionId, enabled]);
  return hints;
}
