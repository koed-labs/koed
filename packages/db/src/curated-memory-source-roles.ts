/** Reconciled bundles and summaries are expansion aids, not the assertion's contributing evidence. */
export const contributingCuratedMemorySourceSql = (
  alias: string
): string => `${alias}.source_role in (
  'primary_evidence','supporting_evidence','superseding_evidence','conflicting_evidence'
)`;
