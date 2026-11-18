// Polls the local Koed database and logs when rows for one AI Client session first appear.
import { createRequire } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const pg = require("pg");
const [, , externalSessionId, outFile, seconds = "420"] = process.argv;
const client = new pg.Client({
  host: "127.0.0.1", port: 45432, user: "koed", database: "koed",
  password: process.env.PGPASSWORD
});
await client.connect();
writeFileSync(outFile, "");
const seen = new Map();
const log = (o) => appendFileSync(outFile, JSON.stringify({ wall: Date.now(), ...o }) + "\n");
const end = Date.now() + Number(seconds) * 1000;
const ts = (d) => (d ? new Date(d).getTime() : null);
while (Date.now() < end) {
  const items = await client.query(
    `select id::text, coalesce(source_record_type,'')||'/'||coalesce(source_event_type,'') as t,
            event_time, observed_at, created_at, projected_at, projection_status
       from conversation_items where external_session_id = $1`, [externalSessionId]);
  for (const r of items.rows) {
    const key = "i:" + r.id; const prev = seen.get(key);
    const state = `${r.projection_status}|${r.projected_at ? 1 : 0}`;
    if (!prev) log({ kind: "item_new", id: r.id, type: r.t, event: ts(r.event_time), created: ts(r.created_at), projected: ts(r.projected_at), status: r.projection_status });
    else if (prev !== state) log({ kind: "item_update", id: r.id, type: r.t, projected: ts(r.projected_at), status: r.projection_status });
    seen.set(key, state);
  }
  const events = await client.query(
    `select e.id::text, e.event_type::text as t, e.source_event_time, e.captured_at, e.created_at, e.seal_reason
       from memory_events e join sessions s on s.id = e.session_id
      where s.external_session_id = $1`, [externalSessionId]);
  for (const r of events.rows) {
    const key = "e:" + r.id;
    if (!seen.has(key)) log({ kind: "event_new", id: r.id, type: r.t, event: ts(r.source_event_time), captured: ts(r.captured_at), created: ts(r.created_at), seal: r.seal_reason });
    seen.set(key, "x");
  }
  await new Promise((r) => setTimeout(r, 400));
}
log({ kind: "done", items: [...seen.keys()].filter((k) => k.startsWith("i:")).length, events: [...seen.keys()].filter((k) => k.startsWith("e:")).length });
await client.end();
