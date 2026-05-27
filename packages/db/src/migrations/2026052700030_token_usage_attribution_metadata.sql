alter table workflow_token_usage
  add column if not exists usage_source text not null default 'app_server',
  add column if not exists usage_accuracy text not null default 'provider_reported',
  add column if not exists usage_kind text not null default 'turn_delta',
  add column if not exists connector_client text,
  add column if not exists tokenizer_package text,
  add column if not exists tokenizer_encoding text,
  add column if not exists tokenizer_model text,
  add column if not exists tokenizer_exact_model_match boolean,
  add column if not exists tokenizer_heuristic_fallback boolean,
  add column if not exists tokenizer_version text;

create index if not exists workflow_token_usage_attribution_idx
  on workflow_token_usage(usage_source, usage_accuracy, usage_kind, observed_at);

create index if not exists workflow_token_usage_connector_idx
  on workflow_token_usage(connector_client, observed_at)
  where connector_client is not null;
