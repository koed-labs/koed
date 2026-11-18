// Asks a session-scoped Memory Answer through the local runtime and times it.
import { readFileSync, appendFileSync } from "node:fs";
const [, , dbSessionId, delaySec, label, out] = process.argv;
await new Promise((r) => setTimeout(r, Number(delaySec) * 1000));
const reg = JSON.parse(readFileSync(process.env.HOME + "/.koed/run/local-ai-runtime.json", "utf8"));
const started = Date.now();
const res = await fetch(new URL("/v1/tools/memory_answer", reg.url), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: reg.authorization },
  body: JSON.stringify({
    input: {
      query: "What has the agent in this session done so far, what step is it on now, and why is it doing it? Say how recent the latest captured activity is.",
      search_domain: "session",
      session_id: dbSessionId,
      response_detail: "with_evidence",
      limit: 10
    },
    caller: { cwd: process.cwd() }
  })
});
const body = await res.text();
appendFileSync(out, JSON.stringify({ label, askedAt: started, finishedAt: Date.now(), status: res.status, body: body.slice(0, 6000) }) + "\n");
console.log(label, "status", res.status, "ms", Date.now() - started);
