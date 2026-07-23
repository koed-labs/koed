ALTER TABLE "memory_nodes" ADD COLUMN "work_class" text DEFAULT 'normal_embedding_lcm' NOT NULL;--> statement-breakpoint
UPDATE "memory_nodes" mn
SET "work_class" = lineage.work_class
FROM (
  SELECT mns.memory_node_id,
    min(processing.work_class) AS work_class
  FROM "memory_node_sources" mns
  JOIN "conversation_projection_processing_outbox" processing
    ON processing.event_id = mns.memory_event_id
  WHERE mns.memory_event_id IS NOT NULL
  GROUP BY mns.memory_node_id
  HAVING min(processing.work_class) = max(processing.work_class)
) lineage
WHERE mn.id = lineage.memory_node_id;--> statement-breakpoint
UPDATE "memory_nodes" parent
SET "work_class" = lineage.work_class
FROM (
  SELECT children.parent_memory_node_id,
    min(child.work_class) AS work_class
  FROM "memory_node_children" children
  JOIN "memory_nodes" child ON child.id = children.child_memory_node_id
  GROUP BY children.parent_memory_node_id
  HAVING min(child.work_class) = max(child.work_class)
) lineage
WHERE parent.id = lineage.parent_memory_node_id;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_work_class_check" CHECK ("memory_nodes"."work_class" in ('live_capture_projection', 'normal_embedding_lcm', 'historical_import_backfill'));