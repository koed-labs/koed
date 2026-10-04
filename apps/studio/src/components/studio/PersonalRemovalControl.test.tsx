import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonalRemovalControl } from "./PersonalRemovalControl";

describe("PersonalRemovalControl", () => {
  it("exposes a labeled removal button that stays visible on touch screens", () => {
    const html = renderToStaticMarkup(
      <PersonalRemovalControl
        kind="conversation"
        name="Design notes"
        onRemove={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Remove Design notes from Studio"');
    expect(html).toContain('title="Remove from Studio"');
    expect(html).toContain("opacity-100");
    expect(html).toContain("sm:opacity-0");
  });
});
