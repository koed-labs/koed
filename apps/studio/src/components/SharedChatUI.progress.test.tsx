import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedChatUI } from "./SharedChatUI";
it("keeps collapsed activity attached to its request when a later exchange is present", () => {
  const html = renderToStaticMarkup(
    <SharedChatUI
      mode={{ kind: "agent", controls: "execution" }}
      scopeKey="conversation"
      messages={[
        { id: "first", role: "user", content: "First request" },
        { id: "reply", role: "assistant", content: "Answer" },
        { id: "next", role: "user", content: "Next request" }
      ]}
      renderMessage={(message) => <p>{message.content}</p>}
      composer={<textarea />}
      progressHistory={[
        {
          key: "turn-one",
          state: "completed",
          label: "Agent activity",
          userMessageId: "first",
          steps: [
            {
              id: "summary",
              title: "Thinking",
              detail: "Checked the project files"
            }
          ]
        }
      ]}
    />
  );
  expect(html.indexOf("Agent activity")).toBeGreaterThan(
    html.indexOf("First request")
  );
  expect(html.indexOf("Agent activity")).toBeLessThan(html.indexOf("Answer"));
  expect(html).toContain("Checked the project files");
  expect(html).not.toMatch(/<details[^>]*\bopen=/);
});
