// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Resizable, ResizableHandle, ResizablePanel } from "@koed/ui";

const actEnvironment = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("Resizable", () => {
  let container: HTMLDivElement;
  let root: Root;
  let capturedPointer = false;
  let releasedPointer = false;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    capturedPointer = false;
    releasedPointer = false;
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: {
        configurable: true,
        value: () => capturedPointer
      },
      releasePointerCapture: {
        configurable: true,
        value: () => {
          capturedPointer = false;
          releasedPointer = true;
        }
      },
      setPointerCapture: {
        configurable: true,
        value: () => {
          capturedPointer = true;
        }
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
    delete (HTMLElement.prototype as Partial<HTMLElement>)
      .releasePointerCapture;
    delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    vi.restoreAllMocks();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  const render = async (reverse = false, size = 320) => {
    const onSizeChange = vi.fn();
    await act(async () =>
      root.render(
        <Resizable
          aria-label="test layout"
          max={440}
          min={200}
          onSizeChange={onSizeChange}
          reverse={reverse}
          size={size}
        >
          <ResizablePanel primary />
          <ResizableHandle aria-label="resize panel" />
          <ResizablePanel />
        </Resizable>
      )
    );
    return onSizeChange;
  };

  const pointerEvent = (type: string, clientX: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, {
      clientX: { value: clientX },
      pointerId: { value: 7 }
    });
    return event;
  };

  it("keeps the default direction and releases pointer capture on cancel", async () => {
    const onSizeChange = await render();
    const handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="resize panel"]'
    );
    expect(handle?.getAttribute("aria-valuenow")).toBe("320");

    await act(async () => {
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
    });
    expect(onSizeChange).toHaveBeenLastCalledWith(312);

    await act(async () => {
      handle?.dispatchEvent(pointerEvent("pointerdown", 100));
      handle?.dispatchEvent(pointerEvent("pointermove", 130));
    });
    expect(onSizeChange).toHaveBeenLastCalledWith(350);

    await act(async () => {
      handle?.dispatchEvent(pointerEvent("pointercancel", 130));
    });
    expect(releasedPointer).toBe(true);
  });

  it("supports reverse sizing for a panel on the right side of its handle", async () => {
    const onSizeChange = await render(true);
    const handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="resize panel"]'
    );

    await act(async () => {
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
    });
    expect(onSizeChange).toHaveBeenLastCalledWith(328);

    await act(async () => {
      handle?.dispatchEvent(pointerEvent("pointerdown", 100));
      handle?.dispatchEvent(pointerEvent("pointermove", 130));
    });
    expect(onSizeChange).toHaveBeenLastCalledWith(290);
  });

  it("clamps keyboard and pointer requests to the configured bounds", async () => {
    const minChange = await render(false, 200);
    let handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="resize panel"]'
    );
    await act(async () => {
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
    });
    expect(minChange).toHaveBeenLastCalledWith(200);
    await act(async () => {
      handle?.dispatchEvent(pointerEvent("pointerdown", 100));
      handle?.dispatchEvent(pointerEvent("pointermove", 40));
    });
    expect(minChange).toHaveBeenLastCalledWith(200);

    const maxChange = await render(false, 440);
    handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="resize panel"]'
    );
    await act(async () => {
      handle?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(maxChange).toHaveBeenLastCalledWith(440);
    await act(async () => {
      handle?.dispatchEvent(pointerEvent("pointerdown", 100));
      handle?.dispatchEvent(pointerEvent("pointermove", 600));
    });
    expect(maxChange).toHaveBeenLastCalledWith(440);
  });
});
