// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { RecallActivityDetail } from "@koed-labs/shared/personal-desktop";
import { recallExecutionSchema } from "@koed-labs/shared/personal-desktop";
import { RecallActivityExecution } from "./RecallActivityExecution.js";

it("renders runtime allowances and accepted scope without guessing defaults or restoring removed captions", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const allowance = (consumed: number, limit: number) => ({
    consumed,
    limit,
    remaining: Math.max(0, limit - consumed)
  });
  const execution = recallExecutionSchema.parse({
    version: 1,
    budgets: {
      evidenceWorkingSet: allowance(8200, 12000),
      finalEvidenceBundle: allowance(4600, 12000),
      cumulativePrompt: allowance(16200, 24000),
      searches: allowance(1, 6),
      expansions: allowance(1, 5),
      attempts: allowance(1, 2),
      exhausted: []
    },
    delivery: {
      operations: [
        {
          kind: "expand",
          attempt: 1,
          delivered: 0,
          omitted: 2,
          reasons: ["recovery_reserve"],
          failed: false,
          recovered: false
        }
      ],
      finalSelected: 2,
      truncated: false
    }
  });
  const detail = {
    question: {
      projectId: null,
      searchDomain: "project",
      scope: {
        kind: "projects",
        provenance: "accepted",
        projects: [
          { projectId: "a", projectName: "Renamed Project" },
          { projectId: "b", projectName: null }
        ],
        label: null
      }
    },
    execution
  } as RecallActivityDetail;
  try {
    await act(async () =>
      root.render(<RecallActivityExecution detail={detail} />)
    );
    expect(container.querySelector(".recall-scope-line")?.textContent).toBe(
      "Project scopeRenamed ProjectProject unavailable"
    );
    const meters = [...container.querySelectorAll('[role="meter"]')];
    expect(
      meters.map((meter) => [
        meter.getAttribute("aria-label"),
        meter.getAttribute("aria-valuenow"),
        meter.getAttribute("aria-valuemax")
      ])
    ).toEqual([
      ["Evidence working set", "8200", "12000"],
      ["Final Evidence Bundle", "4600", "12000"],
      ["Cumulative prompt", "16200", "24000"]
    ]);
    expect(
      container.querySelectorAll(".recall-delivery-operation")
    ).toHaveLength(1);
    expect(container.textContent).toContain("0 delivered · 2 omitted");
    expect(container.textContent).toContain(
      "Prompt room reserved for targeted recovery"
    );
    expect(container.textContent).toContain("2 sources");
    expect(container.textContent).not.toMatch(
      /Runtime defaults|Explicit override|remaining|Last helper-visible|Counts describe|Projects selected/
    );
    await act(async () =>
      root.render(
        <RecallActivityExecution detail={{ ...detail, execution: null }} />
      )
    );
    expect(container.querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(container.textContent).toContain(
      "Execution budgets were not recorded"
    );
    expect(container.textContent).toContain("Source delivery was not recorded");
    expect(container.textContent).not.toContain("24,000");
    expect(
      container.querySelector('[aria-label="Recorded counts"]')
    ).toBeNull();
    await act(async () =>
      root.render(
        <RecallActivityExecution
          detail={{
            ...detail,
            execution: null,
            searchCount: 3,
            expandCount: 1,
            candidateCount: null
          }}
        />
      )
    );
    expect(
      container.querySelector('[aria-label="Recorded counts"]')?.textContent
    ).toBe("searches3expansions1candidatesUnknown");
  } finally {
    await act(async () => root.unmount());
  }
});
