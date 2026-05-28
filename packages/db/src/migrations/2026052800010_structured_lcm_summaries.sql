alter table memory_nodes
  add column if not exists summary_structured_json jsonb,
  add column if not exists summary_structured_schema_version text;

