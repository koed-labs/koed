// Home only needs compact metadata. Reject oversized responses before parsing
// and cancel the stream rather than downloading an unbounded JSON document.
export async function readHomeJson(
  response: Response,
  maxBytes = 1024 * 1024,
  budget?: { remaining: number }
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > Math.min(maxBytes, budget?.remaining ?? maxBytes)) {
    await response.body?.cancel();
    throw new Error("Home response is too large");
  }
  if (!response.body) throw new Error("Home response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (budget) budget.remaining -= value.byteLength;
      if (size > maxBytes || (budget && budget.remaining < 0)) {
        await reader.cancel();
        throw new Error("Home response is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}
