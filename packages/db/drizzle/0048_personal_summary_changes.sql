-- A completed or edited LCM Summary can change shareable evidence after the
-- captured source's last turn. Observe the node itself; title generation is
-- conditional and cannot serve as a reliable source-change notification.
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON memory_nodes
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','session_id');
