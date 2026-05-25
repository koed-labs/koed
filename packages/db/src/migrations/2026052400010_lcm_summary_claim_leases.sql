alter table memory_nodes
  add column if not exists summary_claimed_by text,
  add column if not exists summary_claimed_at timestamptz,
  add column if not exists summary_claim_expires_at timestamptz;

create index if not exists memory_nodes_lcm_summary_claim_idx
  on memory_nodes(summary_claim_expires_at, created_at)
  where invalidated_at is null
    and kind in ('leaf', 'rollup')
    and summary_model is null;
