import assert from "node:assert/strict";

// Exercise real hit testing, pointer capture and portal layout on a populated Home.
export async function validateSidebarTour({
  window,
  page,
  evaluate,
  waitFor,
  paint,
  click,
  pointerClick,
  capture
}) {
  await window.loadFile(page, { query: { projects: "1", tour: "1" } });
  const point = async (selector) =>
    evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
  const mouse = async (type, position) => {
    window.webContents.sendInputEvent({
      type,
      ...position,
      button: "left",
      ...(type === "mouseMove"
        ? { modifiers: ["leftButtonDown"] }
        : { clickCount: 1 })
    });
    await paint();
  };
  const separator = '[role="separator"][aria-orientation="vertical"]';
  const width = () =>
    evaluate(
      "document.querySelector('.v1-navigation-sidebar').getBoundingClientRect().width"
    );
  await waitFor(
    `!!document.querySelector('${separator}')`,
    "the sidebar divider"
  );
  const initialWidth = await width();
  const start = await point(separator);
  const end = { x: start.x + 88, y: start.y };
  await mouse("mouseDown", start);
  await mouse("mouseMove", end);
  await mouse("mouseUp", end);
  assert.equal(await width(), initialWidth + 88);
  await pointerClick('[aria-label="Toggle navigation"]');
  await pointerClick('[aria-label="Toggle navigation"]');
  assert.equal(await width(), initialWidth + 88);

  const tour = "[data-home-tour]";
  await waitFor(
    `document.querySelector('${tour}')?.textContent.includes('Find your conversations')`,
    "the Anchors tip"
  );
  assert.equal(
    await evaluate(
      `document.querySelector('${tour}').getBoundingClientRect().left >= document.querySelector('${separator}').getBoundingClientRect().right`
    ),
    true,
    "the first tip leaves the divider accessible"
  );
  await click(`${tour} button`, "Next");
  await pointerClick('[aria-label="Create Project"]');
  await waitFor(
    "document.activeElement?.id === 'v1-pm-create-name'",
    "the Project name field"
  );
  await window.webContents.insertText("Sidebar tour example");
  await pointerClick('form button[type="submit"]');
  await waitFor(
    "!!document.querySelector('.v1-pm-settings')",
    "the new Project's settings"
  );
  await pointerClick('[aria-label="Close Project settings"]');
  await waitFor(
    "document.querySelector('[data-home-tour]')?.dataset.homeTour === '3'",
    "the drag step after Project creation"
  );
  const source = ".v1-nav-anchors .v1-nav-conversation";
  const title = await evaluate(
    `document.querySelector('${source} .v1-nav-copy').textContent.trim()`
  );
  const target = await evaluate(
    `[...document.querySelectorAll('[data-project-drop]')].find(item => item.querySelector('.v1-nav-project')?.textContent.includes('Sidebar tour example')).dataset.projectDrop`
  );
  const from = await point(source);
  const to = await point(`[data-project-drop="${target}"] .v1-nav-project`);
  await mouse("mouseDown", from);
  await mouse("mouseMove", to);
  const preview = ".v1-pm-drag-ghost";
  const bounds = await evaluate(`(() => {
    const preview = document.querySelector('${preview}');
    const rect = preview?.getBoundingClientRect();
    return rect && { title: preview.textContent.trim(), icon: !!preview.querySelector('svg'), x: rect.x, y: rect.y };
  })()`);
  assert.ok(
    bounds?.icon && bounds.title === title,
    "the preview carries the dragged Conversation"
  );
  assert.ok(
    Math.abs(bounds.x - to.x) < 32 && Math.abs(bounds.y - to.y) < 32,
    "the preview follows the pointer in the viewport"
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.v1-pm-drop-target')?.dataset.projectDrop"
    ),
    target
  );
  const isMember = `window.koedDesktop.personalMemory.listProjects().then(items => items.some(p => p.namedProject?.projectId === ${JSON.stringify(target)} && p.threads?.some(t => t.name === ${JSON.stringify(title)})))`;
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor(
    `!document.querySelector('${preview}')`,
    "Escape to cancel the drag"
  );
  await mouse("mouseUp", to);
  assert.equal(
    await evaluate(isMember),
    false,
    "a canceled drag leaves membership alone"
  );
  assert.equal(await evaluate(`!!document.querySelector('${tour}')`), true);
  await mouse("mouseDown", from);
  await mouse("mouseMove", to);
  await capture("sidebar-tour-drag");
  await mouse("mouseUp", to);
  await waitFor(isMember, "the new Project to include the Conversation");
  assert.equal(await evaluate(`!!document.querySelector('${preview}')`), false);
  await click(`${tour} button`, "Done");
  await waitFor(
    "window.koedDesktop.v1State.readProfile().then(p => p.onboarding.homeTour === 'dismissed')",
    "tour completion to be saved"
  );
  await window.loadFile(page, { query: { projects: "1" } });
  await waitFor(
    `!!document.querySelector('${separator}')`,
    "the sidebar after relaunch"
  );
  assert.equal(await width(), initialWidth + 88);
  assert.equal(await evaluate(`!!document.querySelector('${tour}')`), false);
}
