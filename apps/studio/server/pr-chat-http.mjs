import { prChatPublicError } from "./pr-chat.mjs";

const paths = new Set([
  "/studio-api/pr-chat/status",
  "/studio-api/pr-chat/conversation",
  "/studio-api/pr-chat/message",
  "/studio-api/pr-chat/approval",
  "/studio-api/pr-chat/approval/resolve"
]);

const fail = (code, statusCode = 400) =>
  Object.assign(new Error(code), { statusCode });

async function readBody(request) {
  const maximum = 24 * 1024;
  if (Number(request.headers["content-length"]) > maximum)
    throw fail("body_too_large", 413);
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) throw fail("body_too_large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail("invalid_payload");
  }
}

function validate(input, message) {
  const keys = message
    ? ["repo", "number", "headSha", "baseSha", "text", "requestId", "selection"]
    : [
        "repo",
        "number",
        "headSha",
        "baseSha",
        "requestId",
        "approvalId",
        "decision"
      ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw fail("invalid_payload");
  if (
    typeof input.repo !== "string" ||
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) ||
    input.repo.length > 200 ||
    [".", ".."].includes(input.repo.split("/")[1])
  )
    throw fail("invalid_repository");
  if (
    !Number.isSafeInteger(input.number) ||
    input.number < 1 ||
    input.number > 2147483647
  )
    throw fail("invalid_pull_request");
  if (
    typeof input.headSha !== "string" ||
    !/^[a-f0-9]{7,64}$/i.test(input.headSha)
  )
    throw fail("invalid_head");
  if (
    message &&
    (typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 12000 ||
      typeof input.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId))
  )
    throw fail("invalid_message");
  if (
    input.selection !== undefined &&
    (!input.selection ||
      typeof input.selection !== "object" ||
      Array.isArray(input.selection) ||
      Object.keys(input.selection).some(
        (key) =>
          ![
            "agentId",
            "expectedAgentVersion",
            "provider",
            "model",
            "effort",
            "permissionMode"
          ].includes(key)
      ))
  )
    throw fail("invalid_selection");
  if (
    input.baseSha !== undefined &&
    (typeof input.baseSha !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(input.baseSha))
  )
    throw fail("invalid_base");
  if (
    input.requestId !== undefined &&
    (typeof input.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId))
  )
    throw fail("invalid_request_id");
  if (
    input.approvalId !== undefined &&
    (typeof input.approvalId !== "string" || input.approvalId.length > 200)
  )
    throw fail("invalid_approval_id");
  if (
    input.decision !== undefined &&
    !["accept", "decline"].includes(input.decision)
  )
    throw fail("invalid_decision");
  return input;
}

export async function handlePrChat({ request, url, runtime, validCsrf, send }) {
  if (!paths.has(url.pathname)) return false;
  try {
    const message = url.pathname.endsWith("/message");
    const resolveApproval = url.pathname.endsWith("/approval/resolve");
    const approvalStatus = url.pathname.endsWith("/approval");
    if (request.method !== (message || resolveApproval ? "POST" : "GET"))
      throw fail("method_not_allowed", 405);
    let input;
    if (message || resolveApproval) {
      if (url.search) throw fail("invalid_query");
      if (!validCsrf(request)) throw fail("forbidden", 403);
      if (request.headers["content-type"] !== "application/json")
        throw fail("unsupported_media_type", 415);
      input = validate(await readBody(request), message);
    } else {
      const entries = [...url.searchParams.entries()];
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw fail("invalid_query");
      input = Object.fromEntries(entries);
      if (!/^[1-9][0-9]*$/.test(input.number ?? ""))
        throw fail("invalid_pull_request");
      input.number = Number(input.number);
      input = validate(input, false);
    }
    const result = message
      ? await runtime.sendMessage(input)
      : resolveApproval
        ? await runtime.respondToApproval(input)
        : approvalStatus
          ? await runtime.getPendingApproval(input)
          : url.pathname.endsWith("/status")
            ? await runtime.getStatus(input)
            : await runtime.getConversation(input);
    send(200, result);
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("pr_chat_")) {
      const publicError = prChatPublicError(error);
      send(publicError.status, {
        error: publicError.message,
        code: publicError.error
      });
      return true;
    }
    const status =
      Number.isInteger(error?.statusCode) &&
      error.statusCode >= 400 &&
      error.statusCode < 600
        ? error.statusCode
        : 503;
    // The runtime uses public static errors. Never relay subprocess/provider output.
    send(status, {
      error:
        typeof error?.publicMessage === "string"
          ? error.publicMessage
          : status === 503
            ? "PR chat is unavailable. Check the local AI Client connection and try again."
            : "PR chat request was rejected. Refresh the PR and try again."
    });
  }
  return true;
}
