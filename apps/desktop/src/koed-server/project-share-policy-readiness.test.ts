import { expect, it } from "vitest";
import { createProjectSharePolicyReadiness } from "./project-share-policy-readiness.js";

it("only admits the current local profile after observing registered Team setup", () => {
  let scope = "home-a/profile-a";
  let hasTeamCustody = false;
  const readiness = createProjectSharePolicyReadiness({
    koedHome: () => "/unused",
    readCurrent: () => ({ scope, hasTeamCustody })
  });
  readiness.observe({ upstreamBackends: { registered: 0 } });
  hasTeamCustody = true;
  expect(readiness.eligible()).toBe(false);

  readiness.observe({ upstreamBackends: { registered: 1 } });
  expect(readiness.eligible()).toBe(true);
  scope = "home-b/profile-b";
  expect(readiness.eligible()).toBe(false);
  readiness.observe({ upstreamBackends: { registered: 1 } });
  expect(readiness.eligible()).toBe(true);

  readiness.observe({ upstreamBackends: { registered: 0 } });
  expect(readiness.eligible()).toBe(false);
  readiness.noteRegistered();
  expect(readiness.eligible()).toBe(true);
  hasTeamCustody = false;
  expect(readiness.eligible()).toBe(false);
});
