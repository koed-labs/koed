ALTER TYPE "collaboration_event_family" ADD VALUE IF NOT EXISTS 'message_updated';

ALTER TABLE collaboration_messages
  ADD COLUMN root_message_id uuid,
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE collaboration_messages
  ADD CONSTRAINT collaboration_messages_root_fk
    FOREIGN KEY (thread_id, root_message_id)
    REFERENCES collaboration_messages (thread_id, id)
    ON DELETE CASCADE;

ALTER TABLE collaboration_messages
  DROP CONSTRAINT collaboration_messages_reserved_lifecycle_check;

ALTER TABLE collaboration_messages
  ADD CONSTRAINT collaboration_messages_reserved_lifecycle_check
  CHECK (
    ((edited_at IS NULL AND edited_body_marker IS NULL)
      OR (edited_at IS NOT NULL AND edited_body_marker = '[koed encrypted collaboration message]'))
    AND deleted_at IS NULL
    AND deleted_body_marker IS NULL
    AND version > 0
    AND (root_message_id IS NULL OR root_message_id <> id)
  );

CREATE INDEX collaboration_messages_thread_root_sequence_idx
  ON collaboration_messages (thread_id, root_message_id, thread_sequence DESC);
ALTER TABLE collaboration_messages
  ADD CONSTRAINT collaboration_messages_thread_root_id_sequence_unique
  UNIQUE (thread_id, root_message_id, id, thread_sequence);

CREATE TABLE collaboration_message_revisions (
  message_id uuid NOT NULL,
  revision integer NOT NULL,
  editor_user_id uuid NOT NULL,
  body_marker text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT collaboration_message_revisions_pk PRIMARY KEY (message_id, revision),
  CONSTRAINT collaboration_message_revisions_message_fk FOREIGN KEY (message_id)
    REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  CONSTRAINT collaboration_message_revisions_editor_user_id_users_id_fk FOREIGN KEY (editor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT collaboration_message_revisions_shape_check CHECK (
    revision > 0 AND body_marker = '[koed encrypted collaboration message]'
  )
);

CREATE TABLE collaboration_message_reactions (
  message_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  emoji text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT collaboration_message_reactions_pk PRIMARY KEY (message_id, actor_user_id, emoji),
  CONSTRAINT collaboration_message_reactions_message_fk FOREIGN KEY (message_id)
    REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  CONSTRAINT collaboration_message_reactions_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT collaboration_message_reactions_emoji_check CHECK (emoji IN ('👍','🎉','❤️','😂','👀','🚀','✅','🔥'))
);
CREATE INDEX collaboration_message_reactions_actor_idx
  ON collaboration_message_reactions (actor_user_id, message_id);

CREATE TABLE collaboration_root_receipt_states (
  thread_id uuid NOT NULL,
  root_message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_read_message_id uuid,
  last_read_sequence bigint DEFAULT 0 NOT NULL,
  last_read_at timestamp with time zone,
  version integer DEFAULT 1 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT collaboration_root_receipt_states_pk PRIMARY KEY (root_message_id, user_id),
  CONSTRAINT collaboration_root_receipt_states_root_fk FOREIGN KEY (thread_id, root_message_id)
    REFERENCES collaboration_messages(thread_id, id) ON DELETE CASCADE,
  CONSTRAINT collaboration_root_receipt_states_read_message_fk FOREIGN KEY (thread_id, root_message_id, last_read_message_id, last_read_sequence)
    REFERENCES collaboration_messages(thread_id, root_message_id, id, thread_sequence) ON DELETE CASCADE,
  CONSTRAINT collaboration_root_receipt_states_user_id_users_id_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT collaboration_root_receipt_states_cursor_check CHECK (
    last_read_sequence >= 0 AND version > 0
    AND ((last_read_message_id IS NULL AND last_read_sequence = 0)
      OR (last_read_message_id IS NOT NULL AND last_read_sequence > 0 AND last_read_at IS NOT NULL))
  )
);
CREATE INDEX collaboration_root_receipt_states_user_idx
  ON collaboration_root_receipt_states (user_id, updated_at DESC);
