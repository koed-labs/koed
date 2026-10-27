import assert from "node:assert/strict";
import console from "node:console";
import { runBrowserValidation } from "./browser-validation-runner.mjs";

runBrowserValidation(
  { width: 1100, height: 1000, view: "project-transfer" },
  async ({ evaluate, waitFor, errors, capture, setViewport }) => {
    const click = (selector) =>
      evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const layout = () =>
      evaluate(`(() => {
    const board=document.querySelector('.personal-transfer-board'),panes=[...document.querySelectorAll('.personal-transfer-pane')],lists=[...document.querySelectorAll('.personal-transfer-list')];
    return {width:innerWidth,card:board.getBoundingClientRect().height,panes:panes.map(p=>p.getBoundingClientRect().height),scrollable:lists.map(p=>getComputedStyle(p).overflowY),overflow:document.documentElement.scrollWidth>innerWidth,
      rowOverflow:[...document.querySelectorAll('.personal-transfer-row')].some(row=>row.scrollWidth>row.clientWidth)};
  })()`);
    const layouts = [];
    await waitFor(
      `document.documentElement.dataset.browserValidationReady==='true'&&!!document.querySelector('.personal-project-header')`
    );
    assert.equal(
      await evaluate("!!document.querySelector('.personal-project-transfer')"),
      false
    );
    const underlayTop = await evaluate(
      "document.querySelector('[data-transfer-underlay]').getBoundingClientRect().top"
    );
    const actionSizes = await evaluate(
      "['Set up Project','Project actions'].map(label=>{const rect=document.querySelector('button[aria-label=\"'+label+'\"]').getBoundingClientRect();return [rect.width,rect.height]})"
    );
    assert.deepEqual(actionSizes[0], actionSizes[1]);
    await capture("closed");
    await click('[aria-label="Set up Project"]');
    await waitFor("!!document.querySelector('.personal-project-transfer')");
    assert.equal(
      await evaluate(
        "document.querySelector('[data-transfer-underlay]').getBoundingClientRect().top"
      ),
      underlayTop
    );
    assert.deepEqual(
      await evaluate(
        "(() => {const title=document.querySelector('.personal-transfer-heading [data-slot=dialog-title]').getBoundingClientRect();return [title.width,title.height]})()"
      ),
      [1, 1]
    );
    assert.equal(
      await evaluate("!!document.querySelector('.personal-transfer-kind')"),
      false
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.personal-transfer-caret')).borderTopWidth"
      ),
      "0px"
    );
    for (const width of [1100, 736, 620, 360]) {
      await setViewport(width, 1100);
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
      );
      const before = await layout();
      assert.equal(before.overflow, false);
      assert.equal(before.rowOverflow, false);
      assert.deepEqual(before.scrollable, ["auto", "auto"]);
      assert.equal(before.panes[0], before.panes[1]);
      const dialog = await evaluate(
        "(() => {const r=document.querySelector('.personal-project-setup-dialog').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})()"
      );
      assert.ok(
        Math.abs(dialog.x + dialog.width / 2 - dialog.viewportWidth / 2) < 2
      );
      assert.ok(
        Math.abs(dialog.y + dialog.height / 2 - dialog.viewportHeight / 2) < 2
      );
      assert.ok(
        dialog.y >= 0 && dialog.y + dialog.height <= dialog.viewportHeight
      );
      assert.equal(
        await evaluate(
          "(() => {const popup=document.querySelector('.personal-project-setup-dialog');return popup.scrollHeight>popup.clientHeight})()"
        ),
        false
      );

      await evaluate(
        `(() => {const lists=[...document.querySelectorAll('.personal-transfer-list')];lists[0].scrollTop=100;lists[1].scrollTop=150})()`
      );
      assert.deepEqual(
        await evaluate(
          `[...document.querySelectorAll('.personal-transfer-list')].map(list=>list.scrollTop>0)`
        ),
        [true, true]
      );
      await click('[aria-label="Browse Folders in koed"]');
      await waitFor(`!!document.querySelector('[aria-current="page"]')`);
      const folders = await layout();
      assert.equal(folders.card, before.card);
      assert.deepEqual(folders.panes, before.panes);
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Project inclusions list"]').scrollTop`
        ),
        150
      );
      await click('[aria-label="Browse Conversations in API"]');
      await waitFor(
        `document.querySelector('[aria-current="page"]').textContent==='API'`
      );
      const conversations = await layout();
      assert.equal(conversations.card, before.card);
      assert.deepEqual(conversations.panes, before.panes);
      assert.equal(conversations.overflow, false);
      assert.equal(conversations.rowOverflow, false);
      await evaluate(
        `(() => {const left=document.querySelector('[aria-label="Available sources list"]');left.scrollTop=70;left.querySelector('input:not(:disabled)').click()})()`
      );
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Available sources list"]').scrollTop`
        ),
        70
      );
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Project inclusions list"]').scrollTop`
        ),
        150
      );
      await click('[aria-label="Browse included Folders in koed"]');
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="Available sources list"]').scrollTop`
        ),
        70
      );
      await click('[aria-label="Browse included Conversations in API"]');
      assert.ok(
        await evaluate(
          `document.querySelector('[aria-label="Project inclusions list"]').textContent.includes('Conversation')`
        )
      );
      assert.deepEqual((await layout()).panes, before.panes);
      await click('[aria-label="Project inclusion path"] button');
      await capture(`conversations-${width}`);
      await click(".personal-transfer-navigation button");
      await waitFor(
        `!!document.querySelector('.personal-transfer-navigation [aria-pressed="true"]')`
      );
      layouts.push({ before, folders, conversations });
      await evaluate(
        "document.querySelectorAll('.personal-transfer-list').forEach(list => list.scrollTop = 0)"
      );
      await capture(`sources-${width}`);
    }
    for (const width of [1100, 360]) {
      await setViewport(width, 600);
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
      );
      assert.equal(
        await evaluate(
          "(() => {const popup=document.querySelector('.personal-project-setup-dialog');return popup.scrollHeight>popup.clientHeight})()"
        ),
        false
      );
      await capture(`short-${width}`);
    }
    // Setup stays centered on the window, independent of the detail column.
    await setViewport(1100, 1100);
    await evaluate("document.querySelector('main').style.maxWidth='500px'");
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    assert.ok(
      await evaluate(
        "document.querySelector('.personal-project-setup-dialog').getBoundingClientRect().width>document.querySelector('main').getBoundingClientRect().width+100"
      )
    );
    await capture("centered-over-narrow-column");
    await evaluate(
      "[...document.querySelectorAll('.personal-transfer-footer button')].find(node=>node.textContent==='Cancel').click()"
    );
    await waitFor("!document.querySelector('[role=\"dialog\"]')");
    assert.equal(
      await evaluate("document.activeElement?.getAttribute('aria-label')"),
      "Set up Project"
    );
    await click('[aria-label="Project actions"]');
    await waitFor("!!document.querySelector('[role=\"menuitem\"]')");
    await evaluate(
      "[...document.querySelectorAll('[role=\"menuitem\"]')].find(node=>node.textContent==='Edit').click()"
    );
    await waitFor(
      "document.querySelector('[data-slot=\"dialog-title\"]')?.textContent==='Edit Project'"
    );
    await capture("rename");
    await click('[aria-label="Close"]');
    await waitFor("!document.querySelector('[role=\"dialog\"]')");
    assert.equal(
      await evaluate("document.activeElement?.getAttribute('aria-label')"),
      "Project actions"
    );
    await click('[aria-label="Project actions"]');
    await waitFor("!!document.querySelector('[role=\"menuitem\"]')");
    await evaluate(
      "[...document.querySelectorAll('[role=\"menuitem\"]')].find(node=>node.textContent==='Sync').click()"
    );
    await waitFor(
      "document.querySelector('[data-slot=\"dialog-title\"]')?.textContent==='Project sync details'"
    );
    await capture("sync");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(JSON.stringify({ status: "passed", layouts }));
  }
);
