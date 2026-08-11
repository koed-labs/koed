import assert from "node:assert/strict";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(scriptDir, "../dist/browser-validation.html");
const uuid = (suffix) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ids = {
  alphaTeam: uuid(110),
  alphaWorkspace: uuid(111),
  alphaChannel: uuid(112),
  alphaDm: uuid(114),
  alphaSession: uuid(118),
  betaTeam: uuid(121),
  betaWorkspace: uuid(122),
  betaSession: uuid(127),
  actionGrant: uuid(140)
};
const invitationUrl =
  "https://team.example.test/invitations/accept?token=alpha-1";

const evaluate = (window, source) =>
  window.webContents.executeJavaScript(source);

const waitFor = async (window, source, label) => {
  let observed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    observed = await evaluate(window, source);
    if (observed) return observed;
    await delay(25);
  }
  const body = await evaluate(
    window,
    `document.body?.innerText?.slice(0, 2000) ?? ""`
  );
  throw new Error(
    `Timed out waiting for ${label}; observed=${JSON.stringify(observed)} body=${JSON.stringify(body)}`
  );
};

const waitForReady = (window) =>
  waitFor(
    window,
    `document.documentElement.dataset.browserValidationReady === "true" &&
      Boolean(window.__koedCollaborationInteractions) &&
      Boolean(document.querySelector(".desktop-app-shell"))`,
    "stateful collaboration fixture"
  );

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

const rectFor = async (window, locator) => {
  const rect = await evaluate(
    window,
    `(() => {
      const element = (${locator});
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0
        ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
        : null;
    })()`
  );
  assert.ok(rect, `Expected an interactable element for ${locator}`);
  return rect;
};

const trustedClick = async (window, locator) => {
  window.showInactive();
  window.focus();
  window.webContents.focus();
  const { x, y } = await rectFor(window, locator);
  window.webContents.sendInputEvent({ type: "mouseMove", x, y });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x,
    y,
    button: "left",
    clickCount: 1
  });
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x,
    y,
    button: "left",
    clickCount: 1
  });
  await delay(30);
};

const byText = (selector, text) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent?.trim() === ${JSON.stringify(text)})`;

const trustedType = async (window, locator, value) => {
  await trustedClick(window, locator);
  for (const character of value) {
    window.webContents.sendInputEvent({ type: "char", keyCode: character });
  }
  await delay(20);
};

const trustedKey = async (window, keyCode) => {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await delay(40);
};

const bodyIncludes = (text) =>
  `(document.body?.innerText?.includes(${JSON.stringify(text)}) ?? false)`;
const bodyExcludes = (text) => `!(${bodyIncludes(text)})`;

const commands = (window) =>
  evaluate(window, `window.__koedCollaborationInteractions.commands()`);
const lastCommand = async (window, name) => {
  const all = await commands(window);
  const matching = all.filter((command) => command.command === name);
  assert.ok(matching.length > 0, `Expected ${name} to be recorded`);
  return matching.at(-1);
};

const assertSelection = async (window, expected) => {
  const command = await lastCommand(window, "collaboration.select");
  assert.deepEqual(command.input, { selection: expected });
};

const createWindow = async (actor) => {
  const window = new BrowserWindow({
    show: true,
    opacity: 0,
    skipTaskbar: true,
    width: 1280,
    height: 800
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      process.stderr.write(`[${actor}] renderer error: ${event.message}\n`);
    }
  });
  await window.loadFile(pagePath, {
    query: { view: "collaboration-interactions", actor }
  });
  await waitForReady(window);
  return window;
};

const run = async () => {
  await app.whenReady();
  const windows = [];
  try {
    const [alice, bob] = await Promise.all([
      createWindow("alice"),
      createWindow("bob")
    ]);
    windows.push(alice, bob);

    await waitFor(
      alice,
      bodyIncludes("Workspace Memory Timeline UX"),
      "Alice source"
    );
    await waitFor(
      bob,
      bodyIncludes("Workspace Memory Timeline UX"),
      "Bob source"
    );

    await trustedClick(
      alice,
      `document.querySelector('[title="Cloud Memory Platform"]')`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Cloud Memory Platform")} && ${bodyIncludes("People")} && ${bodyExcludes("Workspace Memory Timeline UX")}`,
      "visible Team navigation replacement"
    );
    await assertSelection(alice, {
      kind: "team_people",
      teamId: ids.betaTeam
    });
    await trustedClick(
      alice,
      `document.querySelector(".desktop-workspace-heading")`
    );
    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "Shared Memory")}`
    );
    await waitFor(
      alice,
      bodyIncludes("Flat User-Owned Memory Model"),
      "Cloud Shared Memory index"
    );
    await assertSelection(alice, {
      kind: "workspace_shared_memory",
      teamId: ids.betaTeam,
      workspaceId: ids.betaWorkspace
    });
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Flat User-Owned Memory Model"]')`
    );
    await waitFor(
      alice,
      bodyIncludes("Deterministic cloud memory rollup replacement."),
      "Cloud Shared Memory source"
    );
    await assertSelection(alice, {
      kind: "shared_session",
      teamId: ids.betaTeam,
      workspaceId: ids.betaWorkspace,
      sharedSessionId: ids.betaSession
    });

    await trustedClick(
      alice,
      `document.querySelector('[title="Electron Team App"]')`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Electron Team App")} && ${bodyIncludes("People")}`,
      "Team switch back to navigation"
    );
    await assertSelection(alice, {
      kind: "team_people",
      teamId: ids.alphaTeam
    });
    await trustedClick(
      alice,
      `document.querySelector(".desktop-workspace-heading")`
    );
    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "Shared Memory")}`
    );
    await waitFor(
      alice,
      bodyIncludes("Workspace Memory Timeline UX"),
      "Electron Shared Memory index"
    );
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Workspace Memory Timeline UX"]')`
    );
    await waitFor(
      alice,
      `(() => {
        const split = document.querySelector('.collab-split');
        const source = document.querySelector('.collab-source-pane');
        const discussion = document.querySelector('.collab-discussion-pane');
        return split?.dataset.layout === 'split' &&
          getComputedStyle(source).display !== 'none' &&
          getComputedStyle(discussion).display !== 'none' &&
          document.body.innerText.includes('Deterministic Electron source replacement.');
      })()`,
      "wide Source and Discussion"
    );
    await setEmulatedViewport(alice, 800, 700);
    await waitFor(
      alice,
      `document.querySelector('.collab-split')?.dataset.layout === 'narrow' &&
        document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Source')`,
      "narrow Source tab"
    );
    await trustedClick(
      alice,
      `document.querySelector('#collab-shared-discussion-tab')`
    );
    await waitFor(
      alice,
      `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Discussion') &&
        getComputedStyle(document.querySelector('.collab-discussion-pane')).display !== 'none'`,
      "narrow Discussion tab"
    );
    await setEmulatedViewport(alice, 1280, 800);

    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "product")}`
    );
    await waitFor(
      alice,
      bodyIncludes("Product channel baseline from Bob."),
      "Alice channel"
    );
    await assertSelection(alice, {
      kind: "workspace_channel",
      teamId: ids.alphaTeam,
      workspaceId: ids.alphaWorkspace,
      threadId: ids.alphaChannel
    });
    await trustedType(
      alice,
      `document.querySelector('textarea[aria-label="Message product"]')`,
      "Alice channel send"
    );
    await trustedKey(alice, "ENTER");
    await waitFor(
      alice,
      bodyIncludes("Alice channel send"),
      "Alice sent channel message"
    );
    const channelSend = await lastCommand(alice, "collaboration.send_message");
    assert.deepEqual(channelSend.input.thread, {
      scope: "team",
      teamId: ids.alphaTeam,
      threadId: ids.alphaChannel
    });
    assert.equal(channelSend.input.body, "Alice channel send");
    assert.match(channelSend.input.clientMessageId, /^[0-9a-f-]{36}$/);

    await trustedClick(
      bob,
      `${byText(".desktop-sidebar-nav-item", "product")}`
    );
    await evaluate(
      bob,
      `(() => {
        const region = document.querySelector('.desktop-live-region');
        window.__koedLiveRegionMutations = 0;
        window.__koedLiveRegionObserver?.disconnect();
        window.__koedLiveRegionObserver = new MutationObserver(() => {
          window.__koedLiveRegionMutations += 1;
        });
        if (region) {
          window.__koedLiveRegionObserver.observe(region, {
            characterData: true,
            childList: true,
            subtree: true
          });
        }
      })()`
    );
    await evaluate(
      bob,
      `window.__koedCollaborationInteractions.emitMessage("channel", "Bob received Alice channel", "alice")`
    );
    await waitFor(
      bob,
      bodyIncludes("Bob received Alice channel"),
      "Bob realtime channel receive"
    );
    await evaluate(
      bob,
      `window.__koedCollaborationInteractions.emitMessage("channel", "Bob received Alice channel", "alice")`
    );
    await delay(75);
    const liveRegion = await evaluate(
      bob,
      `(() => ({
        mutations: window.__koedLiveRegionMutations ?? -1,
        text: document.querySelector('.desktop-live-region')?.textContent ?? ''
      }))()`
    );
    assert.equal(
      liveRegion.mutations,
      2,
      `Distinct messages must each be announced: ${JSON.stringify(liveRegion)}`
    );
    assert.match(liveRegion.text, /New message/i);

    await evaluate(
      bob,
      `(() => {
        window.__koedMarkdownExecution = false;
        window.__koedCollaborationInteractions.emitMessage(
          "channel",
          "[unsafe](javascript:globalThis.__koedMarkdownExecution=true) <script>globalThis.__koedMarkdownExecution=true</script>",
          "alice"
        );
      })()`
    );
    await waitFor(bob, bodyIncludes("unsafe"), "sanitized Markdown message");
    const markdownBoundary = await evaluate(
      bob,
      `(() => ({
        executed: window.__koedMarkdownExecution,
        scripts: document.querySelectorAll('.collab-message-list script').length,
        unsafeLinks: [...document.querySelectorAll('.collab-message-list a')]
          .filter((link) => /^(?:javascript|data|file):/i.test(link.getAttribute('href') ?? ''))
          .length,
        remoteImages: document.querySelectorAll('.collab-message-list img[src^="http"]').length
      }))()`
    );
    assert.deepEqual(markdownBoundary, {
      executed: false,
      scripts: 0,
      unsafeLinks: 0,
      remoteImages: 0
    });

    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "Bob Chen")}`
    );
    await trustedType(
      alice,
      `document.querySelector('textarea[aria-label="Message Bob Chen"]')`,
      "Alice direct send"
    );
    await trustedKey(alice, "ENTER");
    await waitFor(alice, bodyIncludes("Alice direct send"), "Alice sent DM");
    const dmSend = await lastCommand(alice, "collaboration.send_message");
    assert.deepEqual(dmSend.input.thread, {
      scope: "team",
      teamId: ids.alphaTeam,
      threadId: ids.alphaDm
    });
    assert.equal(dmSend.input.body, "Alice direct send");

    await trustedClick(
      bob,
      `${byText(".desktop-sidebar-nav-item", "Alice Nguyen")}`
    );
    await evaluate(
      bob,
      `window.__koedCollaborationInteractions.emitMessage("dm", "Bob received Alice DM", "alice")`
    );
    await waitFor(
      bob,
      bodyIncludes("Bob received Alice DM"),
      "Bob realtime DM receive"
    );
    await trustedClick(bob, `${byText(".desktop-sidebar-nav-item", "People")}`);
    await waitFor(bob, bodyIncludes("Members"), "Bob People view");
    assert.equal(
      await bob.webContents.executeJavaScript(
        'document.body.innerText.includes("Membership") || document.body.innerText.includes("Invites")'
      ),
      false,
      "Bob must not see invitation administration without permission"
    );
    const memberAuthority = await evaluate(
      bob,
      `(() => ({
        invite: [...document.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === 'Invite member'),
        roleControls: document.querySelectorAll('.collab-person-admin-row select').length,
        disable: [...document.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === 'Disable')
      }))()`
    );
    assert.deepEqual(memberAuthority, {
      invite: false,
      roleControls: 0,
      disable: false
    });

    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "People")}`
    );
    await waitFor(alice, bodyIncludes("Invites"), "People administration");
    alice.setSize(1150, 800);
    await delay(50);
    const memberLayout = await evaluate(
      alice,
      `(() => {
        const overlaps = (left, right) =>
          left && right &&
          !(left.right <= right.left || right.right <= left.left ||
            left.bottom <= right.top || right.bottom <= left.top);
        return [...document.querySelectorAll('.collab-person-admin-row')].map((row) => {
          const access = row.querySelector('.collab-access-grid')?.getBoundingClientRect();
          const disable = row.querySelector('.collab-member-disable')?.getBoundingClientRect();
          const role = row.querySelector('.collab-member-role')?.getBoundingClientRect();
          return {
            accessDisableOverlap: Boolean(overlaps(access, disable)),
            roleDisableOverlap: Boolean(overlaps(role, disable)),
            overflow: row.scrollWidth > row.clientWidth
          };
        });
      })()`
    );
    assert.ok(memberLayout.length > 0);
    assert.ok(
      memberLayout.every(
        (row) =>
          !row.accessDisableOverlap && !row.roleDisableOverlap && !row.overflow
      ),
      JSON.stringify(memberLayout)
    );
    await trustedClick(alice, byText("button", "Invite member"));
    await trustedType(
      alice,
      `document.querySelector('input[name="email"]')`,
      "bob.invited@example.test"
    );
    await waitFor(
      alice,
      `document.querySelector('input[name="email"]')?.value === "bob.invited@example.test"`,
      "typed invitation email"
    );
    await trustedClick(
      alice,
      `document.querySelector('[role="dialog"][aria-label="Invite member"] button[type="submit"]')`
    );
    await waitFor(
      alice,
      bodyIncludes("Invitation created for bob.invited@example.test"),
      "invitation creation"
    );
    const createInvitation = await lastCommand(
      alice,
      "collaboration.create_invitation"
    );
    assert.deepEqual(createInvitation.input, {
      teamId: ids.alphaTeam,
      email: "bob.invited@example.test",
      role: "member",
      defaultWorkspaceId: ids.alphaWorkspace,
      defaultWorkspaceAccess: "write",
      ttlHours: 72,
      actionGrant: { id: ids.actionGrant }
    });
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Close Invite member"]')`
    );

    await trustedClick(
      bob,
      `document.querySelector('[aria-label="Add or join Team"]')`
    );
    await trustedClick(
      bob,
      byText("strong", "Join a Team") + `.closest('button')`
    );
    await trustedType(
      bob,
      `document.querySelector('input[name="invitation"]')`,
      invitationUrl
    );
    await waitFor(
      bob,
      `document.querySelector('input[name="invitation"]')?.value === ${JSON.stringify(invitationUrl)}`,
      "typed invitation URL"
    );
    await trustedClick(
      bob,
      `document.querySelector('[role="dialog"][aria-label="Join a Team"] button[type="submit"]')`
    );
    await waitFor(
      bob,
      `!document.querySelector('[role="dialog"][aria-label="Join a Team"]') &&
        Boolean(document.querySelector('[title="Electron Team App"]'))`,
      "invitation acceptance"
    );
    const join = await lastCommand(bob, "collaboration.join_team");
    assert.deepEqual(join.input, {
      invitation: invitationUrl,
      actionGrant: { id: ids.actionGrant }
    });

    await trustedClick(
      bob,
      `document.querySelector('[aria-label="Add or join Team"]')`
    );
    await trustedClick(
      bob,
      byText("strong", "Join a Team") + `.closest('button')`
    );
    await trustedType(
      bob,
      `document.querySelector('input[name="invitation"]')`,
      invitationUrl
    );
    await waitFor(
      bob,
      `document.querySelector('input[name="invitation"]')?.value === ${JSON.stringify(invitationUrl)}`,
      "typed replay URL"
    );
    await trustedClick(
      bob,
      `document.querySelector('[role="dialog"][aria-label="Join a Team"] button[type="submit"]')`
    );
    await waitFor(
      bob,
      bodyIncludes("This item changed. Reload it and try again."),
      "invitation replay rejection"
    );
    const joins = (await commands(bob)).filter(
      (command) => command.command === "collaboration.join_team"
    );
    assert.equal(joins.length, 2);
    assert.deepEqual(joins[0].input, joins[1].input);
    await trustedClick(
      bob,
      `document.querySelector('[aria-label="Close Join a Team"]')`
    );

    await trustedClick(alice, byText("button", "Invite member"));
    await trustedType(
      alice,
      `document.querySelector('input[name="email"]')`,
      "revoke@example.test"
    );
    await waitFor(
      alice,
      `document.querySelector('input[name="email"]')?.value === "revoke@example.test"`,
      "typed revocation email"
    );
    await trustedClick(
      alice,
      `document.querySelector('[role="dialog"][aria-label="Invite member"] button[type="submit"]')`
    );
    await waitFor(
      alice,
      bodyIncludes("Invitation created for revoke@example.test"),
      "revocable invitation creation"
    );
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Close Invite member"]')`
    );
    await trustedClick(
      alice,
      `(() => {
        const row = [...document.querySelectorAll('.collab-invitation-row')]
          .find((item) => item.textContent.includes('revoke@example.test'));
        return row?.querySelector('button');
      })()`
    );
    await waitFor(
      alice,
      bodyExcludes("revoke@example.test"),
      "invitation revocation"
    );
    const revoke = await lastCommand(alice, "collaboration.revoke_invitation");
    assert.deepEqual(revoke.input, {
      teamId: ids.alphaTeam,
      invitationId: uuid(302),
      expectedVersion: 1,
      actionGrant: { id: ids.actionGrant }
    });

    await evaluate(
      bob,
      `window.__koedCollaborationInteractions.setReconnecting()`
    );
    await trustedClick(bob, `document.querySelector('[aria-label="Inbox"]')`);
    await waitFor(
      bob,
      bodyIncludes("Reconnecting to Team Backend"),
      "reconnecting state"
    );
    await trustedClick(
      bob,
      `[...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Reconnecting to Team Backend"))`
    );
    await trustedClick(bob, byText("button", "Reconnect"));
    await waitFor(
      bob,
      bodyExcludes("Reconnecting to Team Backend"),
      "reconnect recovery"
    );
    const reconnect = await lastCommand(bob, "collaboration.reconnect_backend");
    assert.deepEqual(reconnect.input, {});

    const loadsBeforeBackpressure = (await commands(bob)).filter(
      (command) => command.command === "collaboration.load"
    ).length;
    const subscriptionsBeforeBackpressure = (await commands(bob)).filter(
      (command) => command.command === "collaboration.subscribe"
    ).length;
    await evaluate(
      bob,
      `window.__koedCollaborationInteractions.emitBackpressure()`
    );
    await waitFor(
      bob,
      `window.__koedCollaborationInteractions.commands()
        .filter((command) => command.command === "collaboration.load").length >
        ${loadsBeforeBackpressure} &&
        window.__koedCollaborationInteractions.commands()
          .filter((command) => command.command === "collaboration.subscribe").length >
          ${subscriptionsBeforeBackpressure} &&
        Boolean(document.querySelector('[title="Electron Team App"]'))`,
      "backpressure resnapshot recovery"
    );

    await evaluate(
      bob,
      `window.__koedCollaborationInteractions.revokeTeamAccess()`
    );
    await waitFor(
      bob,
      `!document.querySelector('[title="Electron Team App"]') &&
        ${bodyExcludes("Workspace Memory Timeline UX")} &&
        ${bodyExcludes("Bob received Alice DM")}`,
      "access-revocation purge"
    );
    await evaluate(
      bob,
      `window.__koedCollaborationInteractions.emitMessage(
        "channel",
        "stale-after-revocation-sentinel",
        "alice"
      )`
    );
    await delay(100);
    assert.equal(
      await evaluate(bob, bodyIncludes("stale-after-revocation-sentinel")),
      false,
      "A stale Team event repainted protected state after revocation"
    );

    process.stdout.write(
      "Collaboration interaction validation passed: trusted Team switching, invitations, channel/DM delivery, Shared Memory layouts, reconnect/replay/backpressure recovery, and stale-event access purge.\n"
    );
  } finally {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        if (window.webContents.debugger.isAttached()) {
          window.webContents.debugger.detach();
        }
        window.destroy();
      }
    }
  }
};

const hardTimeout = setTimeout(() => {
  process.stderr.write("Collaboration interaction validation timed out.\n");
  app.exit(1);
}, 30_000);

run()
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(hardTimeout);
    app.exit(process.exitCode ?? 0);
  });
