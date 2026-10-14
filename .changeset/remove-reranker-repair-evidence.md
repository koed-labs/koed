---
"@koed/koed": minor
---

Remove the dedicated reranker. Recall keeps the previous disabled-reranker semantic retrieval behavior and existing embedding models and budgets.

Breaking alpha changes: delete reranking response fields, the reranking health flag and retrieval-mode literal, reranker environment settings, model installation and CLI choices, the rerank HTTP endpoint, model process and port, Compose wiring, packaging metadata, benchmarks, and reranker-only evaluation arms. No compatibility shims are provided.

Preserve complete observed evidence references when searched and expanded candidates merge, and retain distinct selected parent summaries alongside partial children within existing evidence budgets. Recovered traces distinguish lost observed aliases from invalid model selections; conflicting parent-node/child-chunk combinations still fail closed.
