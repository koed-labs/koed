CREATE TABLE managed_conversation_recall_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  owner_user_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  answer_kind text NOT NULL,
  answer_id uuid NOT NULL,
  source_association_hash text NOT NULL,
  rating text,
  comment_marker text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT managed_conversation_recall_feedback_owner_execution_fk
    FOREIGN KEY (execution_id, owner_user_id)
    REFERENCES managed_conversation_executions (id, owner_user_id)
    ON DELETE CASCADE,
  CONSTRAINT managed_conversation_recall_feedback_answer_unique
    UNIQUE (owner_user_id, execution_id, answer_kind, answer_id),
  CONSTRAINT managed_conversation_recall_feedback_answer_kind_check
    CHECK (answer_kind IN ('provider', 'agent')),
  CONSTRAINT managed_conversation_recall_feedback_source_hash_check
    CHECK (source_association_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT managed_conversation_recall_feedback_rating_check
    CHECK (rating IS NULL OR rating IN ('up', 'down')),
  CONSTRAINT managed_conversation_recall_feedback_comment_marker_check
    CHECK (comment_marker IS NULL OR comment_marker = '[koed encrypted recall feedback comment]')
);

CREATE INDEX managed_conversation_recall_feedback_owner_updated_idx
  ON managed_conversation_recall_feedback (owner_user_id, updated_at DESC);

ALTER TABLE encrypted_field_payloads
  DROP CONSTRAINT encrypted_field_payloads_source_table_check;

ALTER TABLE encrypted_field_payloads
  ADD CONSTRAINT encrypted_field_payloads_source_table_check
  CHECK (source_table IN (
    'conversation_items',
    'conversation_item_observations',
    'collaboration_messages',
    'collaboration_threads',
    'curated_memory_assertions',
    'curated_memory_proposals',
    'curated_memory_sources',
    'curated_memory_topics',
    'memory_answer_tasks',
    'memory_embeddings',
    'memory_events',
    'memory_nodes',
    'memory_questions',
    'personal_notes',
    'personal_note_revisions',
    'personal_agent_identity_versions',
    'personal_agent_execution_jobs',
    'personal_agent_team_job_publications',
    'memory_replica_revisions',
    'messages',
    'privacy_classification_results',
    'privacy_sanitized_source_artifacts',
    'privacy_sanitized_source_chunks',
    'shared_source_artifacts',
    'shared_source_semantic_previews',
    'shared_source_previews',
    'team_workspaces',
    'team_memory_representations',
    'team_agent_offers',
    'team_agent_requests',
    'managed_conversation_recall_feedback',
    'tool_events'
  ));
