# Implementation follow-ups

- Split `apps/worker/src/managed-conversation-service.ts` along provider adapters,
  command dispatch, leases/recovery, and checkpoint lifecycle boundaries. Keep
  focused tests for ownership, generation fencing, recovery, and shutdown at
  each boundary. PR #392 review F-012 remains a follow-up; avoid combining this
  broad refactor with the runner correctness fixes.
- Complete the `ManagedProjectCockpit` decomposition into independently tested
  diff, files, terminal, and preview panes. Source control now has its own pane
  and typed operation boundary; PR #392 review F-013 remains partially addressed.
