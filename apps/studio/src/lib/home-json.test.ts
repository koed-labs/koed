import { expect, it, vi } from "vitest";
import { readHomeJson } from "./home-json";
it("reads UTF-8 JSON across chunks", async () => {
  const bytes = new TextEncoder().encode('{"title":"Héllo"}');
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 12));
        controller.enqueue(bytes.slice(12));
        controller.close();
      }
    })
  );
  await expect(readHomeJson(response)).resolves.toEqual({ title: "Héllo" });
});
it("cancels responses with an oversized declared length", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { "content-length": "1000" }
  });
  await expect(readHomeJson(response, 100)).rejects.toThrow("too large");
  expect(cancel).toHaveBeenCalledOnce();
});
it("cancels streaming responses when the byte limit is exceeded", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(101));
      },
      cancel
    })
  );
  await expect(readHomeJson(response, 100)).rejects.toThrow("too large");
  expect(cancel).toHaveBeenCalledOnce();
});
it("shares an aggregate budget across paginated responses", async () => {
  const budget = { remaining: 5 };
  await expect(readHomeJson(new Response("{}"), 100, budget)).resolves.toEqual(
    {}
  );
  await expect(readHomeJson(new Response("{}"), 100, budget)).resolves.toEqual(
    {}
  );
  await expect(readHomeJson(new Response("{}"), 100, budget)).rejects.toThrow(
    "too large"
  );
});
