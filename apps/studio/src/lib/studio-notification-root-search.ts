import type {
  CollaborationMessage,
  CollaborationMessagePage
} from "@koed/shared/collaboration";

export const findStudioNotificationRoot = async (
  rootMessageId: string,
  loadPage: (
    direction: "newer" | "older",
    cursor: string | null
  ) => Promise<CollaborationMessagePage | null>,
  maximumPages = 20
): Promise<CollaborationMessage | null> => {
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    const page = await loadPage(cursor === null ? "newer" : "older", cursor);
    if (!page) return null;
    const root = page.items.find((message) => message.id === rootMessageId);
    if (root) return root;
    if (!page.hasOlder || !page.olderCursor) return null;
    cursor = page.olderCursor;
  }
  return null;
};
