import { getTableColumns } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  projectShareExplicitOffers,
  projectShareLocalIssues,
  projectShareMoveFences,
  projectSharePolicyAttempts
} from "./schema.js";

it("keeps distinct creation and update columns in every policy journal", () => {
  for (const table of [
    projectShareExplicitOffers,
    projectShareLocalIssues,
    projectShareMoveFences,
    projectSharePolicyAttempts
  ]) {
    const columns = getTableColumns(table);
    const names = Object.values(columns).map(
      (column: { name: string }) => column.name
    );
    expect(new Set(names).size).toBe(names.length);
    expect(columns.createdAt.name).toBe("created_at");
    expect(columns.updatedAt.name).toBe("updated_at");
  }
});
