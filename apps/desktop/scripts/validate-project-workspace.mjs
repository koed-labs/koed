import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { app, BrowserWindow } from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(scriptDir, "../dist/browser-validation.html");

const inspectWorkspace = async (window) =>
  window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.personal-memory-workspace');
    const master = document.querySelector('.personal-projects-pane');
    const detail = document.querySelector('.personal-memory-detail-pane');
    const title = document.querySelector('.personal-session-copy strong');
    const preview = document.querySelector('.personal-session-copy > small');
    const row = document.querySelector('[data-session-id]');
    const list = document.querySelector('.personal-sessions');
    return {
      body: document.body?.innerText?.slice(0, 1000) ?? '',
      ready: document.documentElement.dataset.browserValidationReady === 'true',
      viewportWidth: window.innerWidth,
      workspaceDisplay: workspace && getComputedStyle(workspace).display,
      masterDisplay: master && getComputedStyle(master).display,
      detailDisplay: detail && getComputedStyle(detail).display,
      titleOverflow: title && title.scrollWidth > title.clientWidth,
      previewOverflow: preview && preview.scrollWidth > preview.clientWidth,
      titleTextOverflow: title && getComputedStyle(title).textOverflow,
      previewTextOverflow: preview && getComputedStyle(preview).textOverflow,
      sourceAiClient: row?.textContent.includes('Codex CLI') ?? false,
      rawMetadataExposed: document.body.textContent.includes('untrusted metadata'),
      foreground: row && getComputedStyle(row).color,
      background: getComputedStyle(document.body).backgroundColor
    };
  })()`);

const setEmulatedViewport = async (window, width, height) => {
  if (!window.webContents.debugger.isAttached()) {
    window.webContents.debugger.attach("1.3");
  }
  await window.webContents.debugger.sendCommand(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false }
  );
  await delay(100);
};

const contrastRatio = (foreground, background) => {
  const channels = (value) =>
    value
      .match(/\d+(?:\.\d+)?/g)
      ?.slice(0, 3)
      .map(Number);
  const luminance = (rgb) => {
    assert.ok(rgb?.length === 3, `Expected RGB color, received ${rgb}`);
    const normalized = rgb
      .map((channel) => channel / 255)
      .map((channel) =>
        channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4
      );
    return (
      0.2126 * normalized[0] + 0.7152 * normalized[1] + 0.0722 * normalized[2]
    );
  };
  const [first, second] = [
    luminance(channels(foreground)),
    luminance(channels(background))
  ].sort((a, b) => b - a);
  return (first + 0.05) / (second + 0.05);
};

const waitForReady = async (window) => {
  let lastState = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    lastState = await window.webContents.executeJavaScript(`(() => ({
      ready: document.documentElement.dataset.browserValidationReady === 'true',
      body: document.body?.innerText?.slice(0, 1000) ?? '',
      rootChildren: document.querySelector('#root')?.childElementCount ?? -1
    }))()`);
    if (lastState.ready) return;
    await delay(25);
  }
  throw new Error(
    `Browser validation fixture did not render: ${JSON.stringify(lastState)}`
  );
};

const waitFor = async (window, source, label) => {
  let observed = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    observed = await window.webContents.executeJavaScript(source);
    if (observed) return;
    await delay(25);
  }
  const body = await window.webContents.executeJavaScript(
    `document.body?.innerText?.slice(0, 1000) ?? ""`
  );
  throw new Error(
    `Timed out waiting for ${label}; observed=${JSON.stringify(observed)} body=${JSON.stringify(body)}`
  );
};

const inspectChat = async (window) =>
  window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.desktop-app-shell');
    const split = document.querySelector('.collab-split');
    const source = document.querySelector('.collab-source-pane');
    const discussion = document.querySelector('.collab-discussion-pane');
    const tabs = document.querySelector('.collab-narrow-tabs');
    const composer = document.querySelector('.collab-composer textarea');
    const selectedTeam = document.querySelector('.desktop-team-rail .desktop-rail-button[aria-current="page"]');
    const teamRail = document.querySelector('.desktop-team-rail');
    const addTeam = document.querySelector('[aria-label="Add or join Team"]');
    const rail = document.querySelector('.desktop-rail');
    const workspaceNames = [...document.querySelectorAll('.desktop-workspace-heading span')];
    const channelNames = [...document.querySelectorAll('.desktop-workspace-section .desktop-sidebar-nav-label')];
    const firstWorkspaceName = workspaceNames[0];
    const firstChannelName = channelNames[0];
    const maximumChannelName = channelNames[1];
    const addTeamRect = addTeam?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    return {
      shellDisplay: shell && getComputedStyle(shell).display,
      splitDisplay: split && getComputedStyle(split).display,
      splitLayout: split?.getAttribute('data-layout') ?? null,
      sourceDisplay: source && getComputedStyle(source).display,
      discussionDisplay: discussion && getComputedStyle(discussion).display,
      tabsDisplay: tabs && getComputedStyle(tabs).display,
      composerVisible: Boolean(composer),
      shellOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sourceCount: document.querySelectorAll('.collab-source-list [role="listitem"]').length,
      messageCount: document.querySelectorAll('.collab-message-list [role="listitem"]').length,
      selectedTeamCount: document.querySelectorAll('.desktop-team-rail .desktop-rail-button[aria-current="page"]').length,
      teamTabStops: [...document.querySelectorAll('.desktop-team-rail .desktop-rail-button')]
        .filter((button) => button.tabIndex === 0).length,
      teamCount: document.querySelectorAll('.desktop-team-rail .desktop-rail-button').length,
      workspaceCount: workspaceNames.length,
      expandedChannelCount: channelNames.length,
      firstWorkspaceNameLength: [...(firstWorkspaceName?.textContent ?? '')].length,
      firstChannelNameLength: [...(firstChannelName?.textContent ?? '')].length,
      maximumChannelNameLength: [...(maximumChannelName?.textContent ?? '')].length,
      firstWorkspaceEllipsis: firstWorkspaceName && getComputedStyle(firstWorkspaceName).textOverflow,
      firstChannelEllipsis: firstChannelName && getComputedStyle(firstChannelName).textOverflow,
      firstWorkspaceClipped: firstWorkspaceName && firstWorkspaceName.scrollWidth > firstWorkspaceName.clientWidth,
      firstChannelClipped: firstChannelName && firstChannelName.scrollWidth > firstChannelName.clientWidth,
      maximumChannelClipped: maximumChannelName && maximumChannelName.scrollWidth > maximumChannelName.clientWidth,
      teamRailScrollTop: teamRail?.scrollTop ?? 0,
      addTeamFullyVisible: Boolean(
        addTeamRect && railRect &&
        addTeamRect.top >= railRect.top && addTeamRect.bottom <= railRect.bottom
      ),
      commandCount: window.__koedBrowserCommandCount ?? 0,
      body: document.body?.innerText?.slice(0, 1000) ?? '',
      foreground: selectedTeam && getComputedStyle(selectedTeam).color,
      background: selectedTeam && getComputedStyle(selectedTeam).backgroundColor
    };
  })()`);

const captureValidationScreenshot = async (window, suffix) => {
  const base = process.env.KOED_BROWSER_VALIDATION_SCREENSHOT;
  if (!base) return;
  const image = await window.webContents.capturePage();
  await writeFile(base.replace(/\.png$/i, `-${suffix}.png`), image.toPNG());
};

const run = async () => {
  await app.whenReady();
  const window = new BrowserWindow({
    show: true,
    opacity: 0,
    skipTaskbar: true,
    width: 1440,
    height: 900
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      process.stderr.write(`Renderer error: ${event.message}\n`);
    }
  });
  try {
    await window.loadFile(pagePath);
    await waitForReady(window);
    await waitFor(
      window,
      `Boolean(document.querySelector('.personal-memory-workspace'))`,
      "Personal Memory workspace"
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('[data-project-id="browser-project"]')?.click()`
    );
    await delay(50);

    const wide = await inspectWorkspace(window);
    assert.equal(wide.workspaceDisplay, "grid");
    assert.equal(wide.masterDisplay, "flex");
    assert.notEqual(wide.detailDisplay, "none");
    assert.equal(wide.titleOverflow, false);
    assert.equal(wide.previewOverflow, false);
    assert.equal(wide.titleTextOverflow, "clip");
    assert.equal(wide.previewTextOverflow, "clip");
    assert.equal(wide.sourceAiClient, true);
    assert.equal(wide.rawMetadataExposed, false);
    assert.ok(
      contrastRatio(wide.foreground, wide.background) >= 4.5,
      JSON.stringify({
        foreground: wide.foreground,
        background: wide.background
      })
    );

    await window.webContents.executeJavaScript(
      `document.querySelector('[data-session-id]')?.click()`
    );
    await waitFor(
      window,
      `document.querySelectorAll('.native-event-wrap').length > 0`,
      "long Captured Session timeline"
    );
    const longSession = await window.webContents.executeJavaScript(`(() => {
      const timeline = document.querySelector('.native-timeline-scroll');
      const before = document.querySelectorAll('.native-event-wrap').length;
      const startedAt = performance.now();
      if (timeline) {
        timeline.scrollTop = timeline.scrollHeight / 2;
        timeline.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      return new Promise((resolve) => requestAnimationFrame(() => resolve({
        before,
        after: document.querySelectorAll('.native-event-wrap').length,
        frameMs: performance.now() - startedAt,
        hasTenThousandLabel: document.body.textContent.includes('10000 Memory Events'),
        scrollable: Boolean(timeline && timeline.scrollHeight > timeline.clientHeight),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      })));
    })()`);
    assert.ok(longSession.before > 0, JSON.stringify(longSession));
    assert.ok(longSession.before <= 250, JSON.stringify(longSession));
    assert.ok(longSession.after <= 250, JSON.stringify(longSession));
    assert.ok(longSession.frameMs < 100, JSON.stringify(longSession));
    assert.equal(
      longSession.hasTenThousandLabel,
      true,
      JSON.stringify(longSession)
    );
    assert.equal(longSession.scrollable, true, JSON.stringify(longSession));
    assert.equal(longSession.overflow, false, JSON.stringify(longSession));

    await setEmulatedViewport(window, 620, 900);
    const narrow = await inspectWorkspace(window);
    assert.equal(narrow.viewportWidth, 620);
    assert.equal(narrow.workspaceDisplay, "block");
    assert.equal(narrow.masterDisplay, "none");

    await window.webContents.executeJavaScript(
      `document.querySelector('.personal-session-detail nav button')?.click()`
    );
    await delay(50);
    const focus = await window.webContents.executeJavaScript(
      `document.activeElement?.getAttribute('data-personal-route-focus')`
    );
    assert.equal(focus, "projects");

    await setEmulatedViewport(window, 1440, 900);
    await window.loadFile(pagePath, { query: { view: "chat" } });
    await waitForReady(window);
    await waitFor(
      window,
      `Boolean(document.querySelector('.collab-split'))`,
      "Shared Session split view"
    );
    const chat = await inspectChat(window);
    assert.equal(chat.shellDisplay, "grid", JSON.stringify(chat));
    assert.equal(chat.splitDisplay, "grid", JSON.stringify(chat));
    assert.equal(chat.splitLayout, "split");
    assert.equal(chat.sourceDisplay, "flex");
    assert.equal(chat.discussionDisplay, "flex");
    assert.equal(chat.tabsDisplay, "none");
    assert.equal(chat.composerVisible, true);
    assert.equal(chat.shellOverflow, false);
    assert.equal(chat.sourceCount, 1);
    assert.equal(chat.messageCount, 2);
    assert.equal(chat.selectedTeamCount, 1);
    assert.equal(chat.teamTabStops, 1);
    assert.equal(chat.teamCount, 50);
    assert.equal(chat.workspaceCount, 20);
    assert.equal(chat.expandedChannelCount, 51);
    assert.equal(chat.firstWorkspaceNameLength, 80);
    assert.equal(chat.firstChannelNameLength, 14);
    assert.equal(chat.maximumChannelNameLength, 80);
    assert.equal(chat.firstWorkspaceEllipsis, "ellipsis");
    assert.equal(chat.firstChannelEllipsis, "ellipsis");
    assert.equal(chat.firstWorkspaceClipped, true);
    assert.equal(chat.maximumChannelClipped, true);
    assert.equal(chat.addTeamFullyVisible, true);
    assert.ok(contrastRatio(chat.foreground, chat.background) >= 4.5);

    const paletteTrigger = await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('[aria-label="Search and commands"]');
      trigger?.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
      return trigger?.getAttribute('aria-label') ?? null;
    })()`);
    assert.equal(paletteTrigger, "Search and commands");
    await waitFor(
      window,
      `document.activeElement?.getAttribute('role') === 'combobox'`,
      "command palette focus"
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ESCAPE" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ESCAPE" });
    await waitFor(
      window,
      `document.activeElement?.getAttribute('aria-label') === 'Search and commands'`,
      "command palette focus restoration"
    );

    let idleCommandCount = chat.commandCount;
    let stableCommandSamples = 0;
    for (
      let attempt = 0;
      attempt < 20 && stableCommandSamples < 5;
      attempt += 1
    ) {
      await delay(100);
      const currentCommandCount = await window.webContents.executeJavaScript(
        `window.__koedBrowserCommandCount ?? 0`
      );
      if (currentCommandCount === idleCommandCount) {
        stableCommandSamples += 1;
      } else {
        idleCommandCount = currentCommandCount;
        stableCommandSamples = 0;
      }
    }
    assert.equal(stableCommandSamples, 5);
    await delay(500);
    const afterIdleCommandCount = await window.webContents.executeJavaScript(
      `window.__koedBrowserCommandCount ?? 0`
    );
    assert.equal(afterIdleCommandCount, idleCommandCount);

    await window.webContents.executeJavaScript(
      `document.querySelector('.desktop-team-rail .desktop-rail-button')?.focus()`
    );
    await delay(20);
    const endHandled = await window.webContents.executeJavaScript(`(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'End',
        code: 'End',
        bubbles: true,
        cancelable: true
      });
      document.activeElement?.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert.equal(endHandled, true);
    await delay(100);
    const railAfterEnd = await window.webContents.executeJavaScript(`(() => {
      const teams = [...document.querySelectorAll('.desktop-team-rail .desktop-rail-button')];
      const last = teams.at(-1);
      return {
        focusedLast: document.activeElement === last,
        lastTabStop: last?.tabIndex === 0,
        scrollTop: document.querySelector('.desktop-team-rail')?.scrollTop ?? 0,
        addTeamVisible: (() => {
          const add = document.querySelector('[aria-label="Add or join Team"]')?.getBoundingClientRect();
          const rail = document.querySelector('.desktop-rail')?.getBoundingClientRect();
          return Boolean(add && rail && add.top >= rail.top && add.bottom <= rail.bottom);
        })()
      };
    })()`);
    assert.equal(railAfterEnd.focusedLast, true, JSON.stringify(railAfterEnd));
    assert.equal(railAfterEnd.lastTabStop, true);
    assert.ok(railAfterEnd.scrollTop > 0);
    assert.equal(railAfterEnd.addTeamVisible, true);

    const teamSelectionCommandCount =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserCommandCount ?? 0`
      );
    const teamSelectionCommandIndex =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserCommands?.length ?? 0`
      );
    const teamSelectionUserCommandIndex =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserUserCommands?.length ?? 0`
      );
    await window.webContents.executeJavaScript(
      `window.__koedRenderProfiles = []`
    );
    const teamSwitchFrameMs = await window.webContents
      .executeJavaScript(`(() => {
      const startedAt = performance.now();
      document.activeElement?.click();
      return new Promise((resolve) =>
        requestAnimationFrame(() => resolve(performance.now() - startedAt))
      );
    })()`);
    await delay(50);
    const afterTeamSelectionCommandCount =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserCommandCount ?? 0`
      );
    const teamSelectionUserCommands =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserUserCommands?.slice(${teamSelectionUserCommandIndex}) ?? []`
      );
    const teamSwitchProfiles = await window.webContents.executeJavaScript(
      `window.__koedRenderProfiles ?? []`
    );
    const teamSelectionCommands = await window.webContents.executeJavaScript(
      `window.__koedBrowserCommands?.slice(${teamSelectionCommandIndex}) ?? []`
    );
    // Team activation selects People, loads its authorized invitation page,
    // records delivery, and reports current-user Team activity.
    assert.deepEqual(teamSelectionCommands, [
      "collaboration.select",
      "collaboration.list_invitations",
      "collaboration.mark_delivered",
      "collaboration.report_team_activity"
    ]);
    assert.deepEqual(teamSelectionUserCommands, [
      "collaboration.select",
      "collaboration.list_invitations",
      "collaboration.mark_delivered"
    ]);
    assert.equal(
      afterTeamSelectionCommandCount - teamSelectionCommandCount,
      teamSelectionUserCommands.length,
      JSON.stringify({ teamSelectionCommands, teamSelectionUserCommands })
    );
    assert.ok(
      teamSwitchFrameMs < 100,
      JSON.stringify({ teamSwitchFrameMs, teamSwitchProfiles })
    );

    const workspaceSelectionCommandCount =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserCommandCount ?? 0`
      );
    const workspaceSelectionCommandIndex =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserCommands?.length ?? 0`
      );
    const workspaceSelectionUserCommandIndex =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserUserCommands?.length ?? 0`
      );
    const workspaceSelectionFrameMs = await window.webContents
      .executeJavaScript(`(() => {
        const startedAt = performance.now();
        document.querySelector('.desktop-workspace-heading')?.click();
        return new Promise((resolve) =>
          requestAnimationFrame(() => resolve(performance.now() - startedAt))
        );
      })()`);
    await delay(20);
    await window.webContents.executeJavaScript(
      `document.querySelectorAll('.desktop-workspace-section .desktop-sidebar-nav-item')[1]?.click()`
    );
    await delay(50);
    const afterWorkspaceSelectionCommandCount =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserCommandCount ?? 0`
      );
    const workspaceSelectionCommands =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserCommands?.slice(${workspaceSelectionCommandIndex}) ?? []`
      );
    const workspaceSelectionUserCommands =
      await window.webContents.executeJavaScript(
        `window.__koedBrowserUserCommands?.slice(${workspaceSelectionUserCommandIndex}) ?? []`
      );
    assert.deepEqual(workspaceSelectionCommands, [
      "collaboration.select",
      "collaboration.mark_delivered",
      "collaboration.report_team_activity"
    ]);
    assert.deepEqual(workspaceSelectionUserCommands, [
      "collaboration.select",
      "collaboration.mark_delivered"
    ]);
    assert.equal(
      afterWorkspaceSelectionCommandCount - workspaceSelectionCommandCount,
      workspaceSelectionUserCommands.length,
      JSON.stringify({
        workspaceSelectionCommands,
        workspaceSelectionUserCommands
      })
    );
    assert.ok(
      workspaceSelectionFrameMs < 100,
      JSON.stringify({ workspaceSelectionFrameMs })
    );
    await captureValidationScreenshot(window, "1440x900");

    for (const width of [1600, 1320, 1120, 960]) {
      await setEmulatedViewport(window, width, 800);
      const sized = await inspectChat(window);
      assert.equal(
        sized.shellOverflow,
        false,
        JSON.stringify({ width, sized })
      );
      assert.ok(sized.teamTabStops === 1, JSON.stringify({ width, sized }));
      assert.ok(
        sized.splitLayout === "split" || sized.splitLayout === "narrow",
        JSON.stringify({ width, sized })
      );
      await captureValidationScreenshot(window, `${width}x800`);
    }

    await setEmulatedViewport(window, 1320, 800);
    const resizedPane = await window.webContents.executeJavaScript(`(() => {
      const divider = document.querySelector('[aria-label="Resize shared source and discussion"]');
      divider?.focus();
      const before = Number(divider?.getAttribute('aria-valuenow'));
      divider?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true
      }));
      return new Promise((resolve) => requestAnimationFrame(() => resolve({
        before,
        after: Number(divider?.getAttribute('aria-valuenow')),
        focused: document.activeElement === divider
      })));
    })()`);
    assert.equal(resizedPane.focused, true, JSON.stringify(resizedPane));
    assert.equal(resizedPane.after, resizedPane.before - 2);

    window.webContents.setZoomFactor(2);
    await delay(100);
    const zoomed = await inspectChat(window);
    assert.equal(zoomed.shellOverflow, false, JSON.stringify(zoomed));
    assert.equal(zoomed.splitLayout, "narrow", JSON.stringify(zoomed));
    await captureValidationScreenshot(window, "1320x800-200-percent");
    window.webContents.setZoomFactor(1);

    await setEmulatedViewport(window, 1280, 720);
    const compactWide = await inspectChat(window);
    assert.equal(compactWide.splitDisplay, "grid");
    assert.equal(compactWide.splitLayout, "split");
    assert.equal(compactWide.sourceDisplay, "flex");
    assert.equal(compactWide.discussionDisplay, "flex");
    assert.equal(compactWide.shellOverflow, false);
    await captureValidationScreenshot(window, "1280x720");

    await setEmulatedViewport(window, 900, 700);
    const mobileSource = await inspectChat(window);
    assert.equal(mobileSource.tabsDisplay, "flex");
    assert.equal(mobileSource.splitLayout, "narrow");
    assert.equal(mobileSource.sourceDisplay, "flex");
    assert.equal(mobileSource.discussionDisplay, "none");
    assert.equal(mobileSource.shellOverflow, false);
    await captureValidationScreenshot(window, "900x700");

    await window.webContents.debugger.sendCommand("Accessibility.enable");
    const accessibility = await window.webContents.debugger.sendCommand(
      "Accessibility.getFullAXTree"
    );
    assert.ok(
      accessibility.nodes.some(
        (node) => node.role?.value === "tab" && node.name?.value === "Source"
      )
    );
    assert.ok(
      accessibility.nodes.some(
        (node) =>
          node.role?.value === "button" &&
          node.name?.value?.startsWith("Koed Team")
      )
    );
    assert.ok(
      accessibility.nodes.some(
        (node) =>
          node.role?.value === "list" &&
          node.name?.value === "Memory Events source items"
      )
    );
    await window.webContents.debugger.sendCommand(
      "Emulation.setEmulatedMedia",
      {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }]
      }
    );
    const reducedMotionDuration = await window.webContents.executeJavaScript(
      `(() => {
        const probe = document.createElement('span');
        probe.className = 'collab-spin';
        document.querySelector('.desktop-app-shell').append(probe);
        const duration = Number.parseFloat(getComputedStyle(probe).animationDuration) || 0;
        probe.remove();
        return duration;
      })()`
    );
    assert.ok(reducedMotionDuration <= 0.001);
    await window.webContents.debugger.sendCommand(
      "Emulation.setEmulatedMedia",
      {
        features: [{ name: "forced-colors", value: "active" }]
      }
    );
    const forcedColors = await window.webContents.executeJavaScript(`(() => {
      const selected = document.querySelector('.desktop-rail-button[data-active]');
      const style = selected && getComputedStyle(selected);
      return {
        active: matchMedia('(forced-colors: active)').matches,
        outlineStyle: style?.outlineStyle ?? null,
        outlineWidth: style?.outlineWidth ?? null
      };
    })()`);
    assert.equal(forcedColors.active, true, JSON.stringify(forcedColors));
    assert.notEqual(
      forcedColors.outlineStyle,
      "none",
      JSON.stringify(forcedColors)
    );
    assert.equal(
      forcedColors.outlineWidth,
      "2px",
      JSON.stringify(forcedColors)
    );
    await window.webContents.debugger.sendCommand(
      "Emulation.setEmulatedMedia",
      { features: [] }
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('#collab-shared-discussion-tab').click()`
    );
    await delay(50);
    const mobileDetail = await window.webContents.executeJavaScript(`(() => ({
      sourceDisplay: getComputedStyle(document.querySelector('.collab-source-pane')).display,
      discussionDisplay: getComputedStyle(document.querySelector('.collab-discussion-pane')).display,
      selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(),
      composerVisible: Boolean(document.querySelector('.collab-composer textarea')),
      shellOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert.equal(mobileDetail.sourceDisplay, "none");
    assert.equal(mobileDetail.discussionDisplay, "flex");
    assert.equal(mobileDetail.selectedTab, "Discussion");
    assert.equal(mobileDetail.composerVisible, true);
    assert.equal(mobileDetail.shellOverflow, false);
    await setEmulatedViewport(window, 720, 600);
    const minimum = await inspectChat(window);
    assert.equal(minimum.splitLayout, "narrow");
    assert.equal(minimum.sourceDisplay, "none");
    assert.equal(minimum.discussionDisplay, "flex");
    assert.equal(minimum.shellOverflow, false);
    await captureValidationScreenshot(window, "720x600");

    await window.webContents.debugger.sendCommand(
      "Emulation.setEmulatedMedia",
      {
        features: [{ name: "prefers-color-scheme", value: "dark" }]
      }
    );
    await window.loadFile(pagePath, { query: { view: "chat" } });
    await waitForReady(window);
    await waitFor(
      window,
      `document.documentElement.classList.contains('dark') && Boolean(document.querySelector('.collab-split'))`,
      "dark Shared Session"
    );
    await setEmulatedViewport(window, 1320, 800);
    const darkContrast = await window.webContents.executeJavaScript(`(() => {
      const normal = document.querySelector('.collab-content-header h1');
      const muted = document.querySelector('.desktop-scope-line');
      const surface = document.querySelector('.collab-content-header');
      const normalStyle = normal && getComputedStyle(normal);
      const mutedStyle = muted && getComputedStyle(muted);
      const surfaceStyle = surface && getComputedStyle(surface);
      return {
        dark: document.documentElement.classList.contains('dark'),
        normalForeground: normalStyle?.color ?? null,
        mutedForeground: mutedStyle?.color ?? null,
        background: surfaceStyle?.backgroundColor ?? null,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert.equal(darkContrast.dark, true, JSON.stringify(darkContrast));
    assert.equal(darkContrast.overflow, false, JSON.stringify(darkContrast));
    assert.ok(
      contrastRatio(darkContrast.normalForeground, darkContrast.background) >=
        4.5,
      JSON.stringify(darkContrast)
    );
    assert.ok(
      contrastRatio(darkContrast.mutedForeground, darkContrast.background) >=
        4.5,
      JSON.stringify(darkContrast)
    );
    await captureValidationScreenshot(window, "1320x800-dark");

    await window.loadFile(pagePath, { query: { view: "timeline" } });
    await waitForReady(window);
    await delay(250);
    const timeline = await window.webContents.executeJavaScript(`(() => ({
      total: Number(document.querySelector('[data-total-items]')?.getAttribute('data-total-items')),
      rendered: document.querySelectorAll('[data-timeline-item]').length,
      hasLastItem: Boolean(document.querySelector('[data-timeline-item="timeline-9999"]')),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert.equal(timeline.total, 10_000);
    assert.ok(timeline.rendered > 0);
    assert.ok(timeline.rendered <= 250);
    assert.equal(timeline.hasLastItem, true);
    assert.equal(timeline.overflow, false);
  } finally {
    if (window.webContents.debugger.isAttached()) {
      window.webContents.debugger.detach();
    }
    window.destroy();
    app.quit();
  }
};

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});
