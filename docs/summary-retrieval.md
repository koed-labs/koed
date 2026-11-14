# LCM Summary Retrieval

Embedding chunks remain the search representation of an LCM Summary. Recall
groups matching chunks by authorized Memory Node identity and summary embedding
revision before candidate limits and Global pool admission. The strongest chunk
score ranks the group; additional chunks do not multiply its score or consume
independent evidence slots. Unrelated nodes remain distinct even when their
summary text is identical. Current-repository reservation and existing limits
are unchanged.

Each admitted group is authorized and hydrated once. A fully authorized group
returns its complete summary with `summaryRepresentation: "complete_summary"`.
Its primary citation identifies the strongest match; `observedReferences` retains
the matched chunk citations, parent references, and pool provenance. Stale summary
embedding hashes are excluded rather than relabeled with the current revision.

Source selection, ownership, time bounds, and encryption checks still determine
the representation that can be disclosed. A partially selected pending node
returns only its eligible source outline with
`summaryRepresentation: "filtered_sources"`; grouping never upgrades that
outline to unrestricted summary content.

An Evidence Bundle counts a complete summary once and charges its actual
delivered tokens once. Complete summaries must not be silently shortened to an
ordinary search preview. If one cannot fit the existing evidence budget, the
Memory Answer worker reports the oversized evidence condition and retains a
supported follow-up path without increasing the budget.

An explicit source expansion gives its requested complete sources priority over
earlier working-set summaries. Omitted-source navigation lets the helper narrow
another authorized expansion; it does not make unseen text selectable evidence.
Previously observed summaries retain their stable references for explicit final
selection. See [evidence admission](durable-memory-answer.md#complete-evidence-admission)
for serialization accounting, omission reporting and unchanged access limits.
