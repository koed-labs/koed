alter table sessions
  add column if not exists metadata jsonb not null default '{}'::jsonb;

drop trigger if exists sessions_graph_update_notify on sessions;
create trigger sessions_graph_update_notify
after insert or update or delete on sessions
for each row execute function notify_koed_graph_update();
