import { useState } from "react";
import {
  addTransferSource,
  hasTransferInclusion,
  type TransferInclusion,
  type TransferMutation,
  type TransferSource
} from "./project-transfer-model.js";

type Draft = { inclusions: TransferInclusion[]; excluded: TransferSource[] };

/** Keep edits local until Confirm; closing the dialog discards this draft. */
export function useProjectTransferDraft(
  initial: TransferInclusion[],
  version: number
) {
  const [base] = useState(() => ({ inclusions: initial, version }));
  const [draft, update] = useState<Draft>({
    inclusions: base.inclusions,
    excluded: []
  });
  const commands: TransferMutation[] = [
    ...base.inclusions
      .filter((row) => !draft.inclusions.some((entry) => entry.id === row.id))
      .map((row) => ({ action: row.removal, inclusionId: row.inclusionId })),
    ...draft.inclusions
      .filter((row) => !base.inclusions.some((entry) => entry.id === row.id))
      .flatMap((row) => {
        const command = addTransferSource(row);
        return command ? [command] : [];
      }),
    ...draft.excluded.flatMap((row) =>
      row.sessionId
        ? [{ action: "exclude_session" as const, sessionId: row.sessionId }]
        : []
    )
  ];
  return {
    ...draft,
    commands,
    version: base.version,
    include: (rows: TransferSource[]) =>
      update((previous) => ({
        ...previous,
        inclusions: [
          ...previous.inclusions,
          ...rows
            .filter((row) => !hasTransferInclusion(row, previous.inclusions))
            .map(
              (row): TransferInclusion =>
                base.inclusions.find((entry) =>
                  hasTransferInclusion(row, [entry])
                ) ?? {
                  ...row,
                  id: `draft:${row.id}`,
                  inclusionId: row.id,
                  removal:
                    row.kind === "session" ? "remove_inclusion" : "remove_rule"
                }
            )
        ]
      })),
    remove: (rows: TransferSource[]) =>
      update((previous) => ({
        inclusions: previous.inclusions.filter(
          (row) => !rows.some((entry) => entry.id === row.id)
        ),
        excluded: [
          ...previous.excluded,
          ...rows.filter(
            (row) =>
              row.kind === "session" &&
              !previous.inclusions.some((entry) => entry.id === row.id) &&
              !previous.excluded.some((entry) => entry.id === row.id)
          )
        ]
      }))
  };
}
