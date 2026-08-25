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
  aliceNote: uuid(130),
  aliceNoteMemoryEvent: uuid(132),
  aliceNoteLogicalMemory: uuid(134),
  actionGrant: uuid(140),
  notePendingShare: uuid(720),
  noteGrant: uuid(724)
};
const invitationUrl =
  "https://team.example.test/invitations/accept?token=alpha-1";
const ownerOnlyCredentialSource =
  "username: preview-owner password: correct-horse-battery-staple";
const teamSafeCredentialSource = "username: [USERNAME] password: [SECRET]";

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
  const activeElement = await evaluate(
    window,
    `document.activeElement?.outerHTML?.slice(0, 1000) ?? ""`
  );
  throw new Error(
    `Timed out waiting for ${label}; observed=${JSON.stringify(observed)} active=${JSON.stringify(activeElement)} body=${JSON.stringify(body)}`
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

const setReducedMotion = async (window) => {
  if (!window.webContents.debugger.isAttached()) {
    window.webContents.debugger.attach("1.3");
  }
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
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

const trustedReplace = async (window, locator, value) => {
  await trustedClick(window, locator);
  await evaluate(
    window,
    `(() => {
      const input = (${locator});
      const prototype = input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : null;
      if (!prototype) return false;
      const setter = Object.getOwnPropertyDescriptor(
        prototype,
        'value'
      )?.set;
      setter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    })()`
  );
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
const personalMemoryCommands = (window) =>
  evaluate(window, `window.__koedPersonalMemoryCommands ?? []`);
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
    assert.equal(
      await evaluate(alice, bodyIncludes(teamSafeCredentialSource)),
      true,
      "The teammate must see the privacy-filtered Team representation"
    );
    assert.equal(
      await evaluate(alice, bodyIncludes(ownerOnlyCredentialSource)),
      false,
      "The owner-only credential source leaked into the teammate Team view"
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

    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Personal"]')`
    );
    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "Notes")}`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Browser launch note")} && ${bodyIncludes("New Note")}`,
      "Personal Note list"
    );
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="New Note"]')`
    );
    await waitFor(
      alice,
      `Boolean(document.querySelector('textarea[aria-label="Note content"]'))`,
      "new Personal Note composer"
    );
    await trustedType(
      alice,
      `document.querySelector('textarea[aria-label="Note content"]')`,
      "Browser-created durable Note"
    );
    await trustedClick(alice, `${byText("button", "Save Note")}`);
    const noteCommands = await personalMemoryCommands(alice);
    const createdNote = noteCommands.at(-1);
    assert.equal(createdNote?.operation, "personal.notes.create");
    assert.equal(createdNote?.input.body, "Browser-created durable Note");
    assert.equal(typeof createdNote?.input.idempotencyKey, "string");
    await trustedClick(
      alice,
      `[...document.querySelectorAll('.personal-note-items > button')]
        .find((button) => button.textContent?.includes('Browser launch note'))`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Two independent reviewers are required.")} && Boolean(document.querySelector('[aria-label="Rename Note"]'))`,
      "Personal Note exact detail"
    );
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Rename Note"]')`
    );
    await waitFor(
      alice,
      `Boolean(document.querySelector('.personal-note-header input')) && Boolean(document.querySelector('[aria-label="Save Note title"]'))`,
      "Personal Note rename editor"
    );
    await trustedReplace(
      alice,
      `document.querySelector('.personal-note-header input')`,
      "Renamed browser Note"
    );
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Save Note title"]')`
    );
    await waitFor(
      alice,
      bodyIncludes("Renamed browser Note"),
      "Personal Note title rename"
    );
    await setEmulatedViewport(alice, 640, 800);
    await waitFor(
      alice,
      `document.querySelector('.personal-notes-workspace')?.dataset.narrowView === 'detail' && ${bodyIncludes("Back to Notes")}`,
      "narrow Personal Note detail"
    );
    await setEmulatedViewport(alice, 1280, 800);
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Share Note"]')`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Share Note")} && ${bodyIncludes("Keep this Note up to date")} && ${bodyIncludes("Later edits will replace the Team copy after privacy checks finish.")} && ${bodyIncludes("Review")}`,
      "Continuous Personal Note Share review"
    );
    await trustedClick(alice, `${byText("button", "Review")}`);
    await waitFor(
      alice,
      `${bodyIncludes("Approve to share this note with Electron Team App.")} && ${bodyIncludes("Later edits will replace the Team copy after privacy checks finish.")}`,
      "exact Personal Note candidate preview"
    );
    await trustedClick(alice, `${byText("button", "Approve and share")}`);
    await waitFor(
      alice,
      bodyIncludes("Share accepted"),
      "Personal Note Pending Share progress"
    );
    const noteCandidate = await lastCommand(
      alice,
      "collaboration.preview_shared_memory_candidate"
    );
    assert.deepEqual(noteCandidate.input, {
      source: {
        kind: "personal_note",
        noteId: ids.aliceNote,
        noteRevision: 1,
        memoryEventId: ids.aliceNoteMemoryEvent,
        logicalMemoryId: ids.aliceNoteLogicalMemory
      },
      mode: "continuous",
      activationRepresentation: "memory_events"
    });
    const noteShare = await lastCommand(alice, "collaboration.share_memory");
    assert.deepEqual(noteShare.input.source, {
      kind: "personal_note",
      noteId: ids.aliceNote,
      noteRevision: 1,
      memoryEventId: ids.aliceNoteMemoryEvent,
      logicalMemoryId: ids.aliceNoteLogicalMemory
    });
    assert.equal(noteShare.input.mode, "continuous");
    assert.deepEqual(noteShare.input.sourceCapabilities, ["memory_events"]);
    assert.equal(noteShare.input.activationRepresentation, "memory_events");
    assert.equal(noteShare.input.maximumFidelity, "memory_events");
    assert.equal(noteShare.input.includeCuratedMemory, false);
    await trustedClick(alice, `${byText("button", "Close")}`);

    const revisionTwoBody =
      "# Continuous browser revision two\nPrivacy-safe replacement content.";
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Edit Note content"]')`
    );
    await waitFor(
      alice,
      `Boolean(document.querySelector('textarea[aria-label="Note content"]'))`,
      "Personal Note revision editor"
    );
    await trustedReplace(
      alice,
      `document.querySelector('textarea[aria-label="Note content"]')`,
      revisionTwoBody
    );
    await trustedClick(
      alice,
      `${byText(".personal-note-edit-actions button", "Save")}`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Continuous browser revision two")} && !document.querySelector('textarea[aria-label="Note content"]')`,
      "saved Personal Note revision two"
    );
    const revisionTwoCommand = (await personalMemoryCommands(alice)).at(-1);
    assert.equal(revisionTwoCommand?.operation, "personal.notes.update");
    assert.equal(revisionTwoCommand?.input.noteId, ids.aliceNote);
    assert.equal(revisionTwoCommand?.input.expectedRevision, 1);
    assert.equal(revisionTwoCommand?.input.body, revisionTwoBody);
    assert.equal(
      typeof revisionTwoCommand?.input.idempotencyKey,
      "string",
      "Personal Note revisions require an idempotency key"
    );

    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "Shares")}`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Packaged asynchronous sharing")} && ${bodyIncludes("Browser launch note")}`,
      "owner-wide Shares route"
    );
    await trustedClick(
      alice,
      `[...document.querySelectorAll('.collab-share-row')]
        .find((item) => item.textContent?.includes('Browser launch note'))`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Revision 1")} && ${bodyIncludes("Two independent reviewers are required.")} && ${bodyExcludes("Privacy-safe replacement content.")}`,
      "last authorized Note revision while update is preparing"
    );
    await evaluate(
      alice,
      `window.__koedCollaborationInteractions.completeContinuousNoteRevision()`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Continuous browser revision two")} && ${bodyIncludes("Revision 2")} && ${bodyIncludes("Privacy-safe replacement content.")}`,
      "atomically published Continuous Note revision two"
    );
    await trustedClick(alice, `${byText("button", "Modify")}`);
    await trustedClick(alice, `${byText("button", "Pause updates")}`);
    await waitFor(
      alice,
      `${byText("button", "Resume updates")} === document.activeElement`,
      "paused Continuous Note updates"
    );
    const pauseNote = await lastCommand(
      alice,
      "collaboration.control_pending_share"
    );
    assert.equal(pauseNote.input.pendingShareId, ids.notePendingShare);
    assert.equal(pauseNote.input.expectedOperationVersion, 4);
    assert.equal(pauseNote.input.action, "pause");
    assert.equal(typeof pauseNote.input.mutationId, "string");
    await trustedClick(alice, `${byText("button", "Done")}`);

    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "Notes")}`
    );
    await trustedClick(
      alice,
      `[...document.querySelectorAll('.personal-note-items > button')]
        .find((button) => button.textContent?.includes('Renamed browser Note'))`
    );
    await trustedClick(
      alice,
      `document.querySelector('[aria-label="Edit Note content"]')`
    );
    const revisionThreeBody =
      "# Continuous browser revision three\nCatch up only after updates resume.";
    await trustedReplace(
      alice,
      `document.querySelector('textarea[aria-label="Note content"]')`,
      revisionThreeBody
    );
    await trustedClick(
      alice,
      `${byText(".personal-note-edit-actions button", "Save")}`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Continuous browser revision three")} && !document.querySelector('textarea[aria-label="Note content"]')`,
      "saved Personal Note revision three while paused"
    );
    await trustedClick(
      alice,
      `${byText(".desktop-sidebar-nav-item", "Shares")}`
    );
    await trustedClick(
      alice,
      `[...document.querySelectorAll('.collab-share-row')]
        .find((item) => item.textContent?.includes('Continuous browser revision two'))`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Updates paused")} && ${bodyIncludes("Revision 2")} && ${bodyIncludes("Privacy-safe replacement content.")} && ${bodyExcludes("Catch up only after updates resume.")}`,
      "paused Note Share retains its last authorized revision"
    );
    await trustedClick(alice, `${byText("button", "Modify")}`);
    await trustedClick(alice, `${byText("button", "Resume updates")}`);
    await waitFor(
      alice,
      bodyIncludes("Sharing updates"),
      "Continuous Note catch-up preparation"
    );
    const resumeNote = await lastCommand(
      alice,
      "collaboration.control_pending_share"
    );
    assert.equal(resumeNote.input.pendingShareId, ids.notePendingShare);
    assert.equal(resumeNote.input.expectedOperationVersion, 5);
    assert.equal(resumeNote.input.action, "resume");
    assert.equal(typeof resumeNote.input.mutationId, "string");
    await trustedClick(alice, `${byText("button", "Done")}`);
    await evaluate(
      alice,
      `window.__koedCollaborationInteractions.completeContinuousNoteRevision()`
    );
    await waitFor(
      alice,
      `${bodyIncludes("Continuous browser revision three")} && ${bodyIncludes("Revision 3")} && ${bodyIncludes("Catch up only after updates resume.")}`,
      "resumed Continuous Note catches up to revision three"
    );

    const noteRevocationsBeforeCancel = (await commands(alice)).filter(
      (command) => command.command === "collaboration.revoke_shared_memory"
    ).length;
    await trustedClick(alice, `${byText("button", "Revoke")}`);
    await waitFor(
      alice,
      bodyIncludes("Your Personal Memory will not be deleted."),
      "Continuous Note revocation confirmation"
    );
    await trustedClick(alice, `${byText("button", "Cancel")}`);
    await waitFor(
      alice,
      bodyExcludes("Your Personal Memory will not be deleted."),
      "canceled Continuous Note revocation confirmation"
    );
    assert.equal(
      (await commands(alice)).filter(
        (command) => command.command === "collaboration.revoke_shared_memory"
      ).length,
      noteRevocationsBeforeCancel,
      "Canceling Continuous Note revocation must preserve access"
    );
    await trustedClick(alice, `${byText("button", "Revoke")}`);
    await waitFor(
      alice,
      bodyIncludes("Your Personal Memory will not be deleted."),
      "reopened Continuous Note revocation confirmation"
    );
    await trustedClick(alice, `${byText("button", "Revoke Share")}`);
    await waitFor(
      alice,
      `[...document.querySelectorAll('[aria-labelledby="collab-revoked-shares"] .collab-share-row')]
        .some((item) => item.textContent?.includes('Continuous browser revision three'))`,
      "revoked Continuous Note Share"
    );
    const noteRevocation = await lastCommand(
      alice,
      "collaboration.revoke_shared_memory"
    );
    assert.equal(noteRevocation.input.shareGrantId, ids.noteGrant);

    await trustedClick(
      alice,
      `[...document.querySelectorAll('.collab-share-row')]
        .find((item) => item.textContent?.includes('Packaged asynchronous sharing'))`
    );
    await trustedClick(alice, `${byText("button", "Modify")}`);
    await trustedClick(alice, `${byText("button", "Pause updates")}`);
    await waitFor(
      alice,
      `${byText("button", "Resume updates")} === document.activeElement && ${bodyIncludes("Packaged asynchronous sharing")}`,
      "stable focus after pausing updates"
    );
    await trustedClick(alice, `${byText("button", "Done")}`);
    await trustedClick(
      alice,
      `[...document.querySelectorAll('.collab-share-row')]
        .find((item) => item.textContent?.includes('Packaged revocation fixture'))`
    );
    await waitFor(
      alice,
      `${bodyIncludes(ownerOnlyCredentialSource)} &&
        document.querySelector('.collab-share-facts .collab-share-state')?.textContent?.trim().toLowerCase() === 'active'`,
      "active owner-only Personal source preview"
    );
    assert.equal(
      await evaluate(alice, bodyIncludes(teamSafeCredentialSource)),
      false,
      "The owner Personal source preview was replaced by the Team derivative"
    );
    await evaluate(
      alice,
      `window.__koedCollaborationInteractions.emitPendingShareNeedsAttention()`
    );
    await waitFor(
      alice,
      `document.activeElement?.textContent?.includes('Packaged revocation fixture') &&
        document.querySelector('.collab-share-detail-workspace')?.textContent?.includes('Packaged revocation fixture') &&
        [...document.querySelectorAll('[role="status"][aria-live="polite"]')]
          .some((item) => item.textContent?.includes('Packaged asynchronous sharing: Update needs attention'))`,
      "stable selection and live announcement after background update"
    );
    await setReducedMotion(alice);
    const reducedMotion = await evaluate(
      alice,
      `(() => {
        const card = document.querySelector('.collab-share-row');
        return {
          active: matchMedia('(prefers-reduced-motion: reduce)').matches,
          transitionDuration: card ? getComputedStyle(card).transitionDuration : null
        };
      })()`
    );
    assert.equal(reducedMotion.active, true);
    assert.ok(
      Number.parseFloat(reducedMotion.transitionDuration ?? "1") <= 0.001,
      `Expected reduced transition duration, received ${reducedMotion.transitionDuration}`
    );

    const snapshotRevocationCommandsBeforeCancel = (
      await commands(alice)
    ).filter(
      (command) => command.command === "collaboration.revoke_shared_memory"
    );
    assert.deepEqual(
      snapshotRevocationCommandsBeforeCancel.map(
        (command) => command.input.shareGrantId
      ),
      [ids.noteGrant],
      "Continuous Note revocation must not revoke another Share Grant"
    );
    const snapshotRevocationsBeforeCancel =
      snapshotRevocationCommandsBeforeCancel.length;
    await trustedClick(alice, `${byText("button", "Revoke")}`);
    await waitFor(
      alice,
      bodyIncludes("Your Personal Memory will not be deleted."),
      "Share revocation confirmation"
    );
    await trustedClick(alice, `${byText("button", "Cancel")}`);
    await waitFor(
      alice,
      bodyExcludes("Your Personal Memory will not be deleted."),
      "canceled Share revocation confirmation"
    );
    assert.equal(
      (await commands(alice)).filter(
        (command) => command.command === "collaboration.revoke_shared_memory"
      ).length,
      snapshotRevocationsBeforeCancel,
      "Canceling destructive confirmation must preserve access"
    );
    await trustedClick(alice, `${byText("button", "Revoke")}`);
    await waitFor(
      alice,
      bodyIncludes("Your Personal Memory will not be deleted."),
      "reopened captured-session revocation confirmation"
    );
    await trustedClick(alice, `${byText("button", "Revoke Share")}`);
    await waitFor(
      alice,
      `[...document.querySelectorAll('[aria-labelledby="collab-revoked-shares"] .collab-share-row')]
        .some((item) => item.textContent?.includes('Packaged revocation fixture')) &&
        document.querySelector('.collab-share-detail-workspace')?.textContent?.includes('Packaged revocation fixture')`,
      "confirmed Workspace revocation"
    );

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
      "Collaboration interaction validation passed: Personal Note create/load/rename, Continuous Share revision publication, pause/resume catch-up and revocation, owner-only source versus Team-safe representation, owner-wide Shares access and accessibility, trusted Team switching, invitations, channel/DM delivery, Shared Memory layouts, reconnect/replay/backpressure recovery, and stale-event access purge.\n"
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
