import { describe, expect, it, vi } from "vitest";
// workers/app.ts mentions "virtual:react-router/server-build" only inside the
// lazy callback handed to createRequestHandler. Vitest (Vite's SSR transform)
// resolves dynamic imports at call time, and the paths under test — the
// health endpoint and the queue consumer — never invoke that callback, so the
// virtual module does not need to exist in this test environment.
import worker, { type SocialEvent } from "./app";

type WorkerRequest = Parameters<NonNullable<(typeof worker)["fetch"]>>[0];

function healthRequest() {
  return new Request("http://test.local/api/health") as unknown as WorkerRequest;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe("worker fetch", () => {
  it("reports a healthy runtime with a connected database", async () => {
    const response = await worker.fetch?.(healthRequest(), { DB: {} } as unknown as Env, ctx);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      runtime: "cloudflare-workers",
      database: "connected",
    });
  });

  it("reports a missing database binding", async () => {
    const response = await worker.fetch?.(healthRequest(), {} as Env, ctx);
    expect(await response?.json()).toMatchObject({ ok: true, database: "not-configured" });
  });
});

describe("worker queue", () => {
  it("logs and acks every message in the batch", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const acks = [vi.fn(), vi.fn()];
      const messages = [
        { body: { type: "post.created", actorId: "a", objectId: "p1", occurredAt: "now" }, ack: acks[0] },
        { body: { type: "reaction.changed", actorId: "b", objectId: "p2", occurredAt: "now" }, ack: acks[1] },
      ];
      const batch = { messages } as unknown as MessageBatch<SocialEvent>;
      await worker.queue?.(batch);
      for (const ack of acks) expect(ack).toHaveBeenCalledTimes(1);
      expect(consoleLog).toHaveBeenCalledWith("social event", "post.created", "p1");
      expect(consoleLog).toHaveBeenCalledWith("social event", "reaction.changed", "p2");
    } finally {
      consoleLog.mockRestore();
    }
  });
});
