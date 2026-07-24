import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDbPool, databaseErrorCode } from "./connection.js";

describe("database connection", () => {
  it("handles idle-client pool errors without terminating the process", async () => {
    const onPoolError = vi.fn();
    const pool = createDbPool({
      connectionString: "postgres://koed:koed@127.0.0.1:1/koed",
      onPoolError
    });
    const error = Object.assign(new Error("database restarted"), {
      code: "57P01"
    });

    expect(() => pool.emit("error", error, {} as never)).not.toThrow();
    expect(onPoolError).toHaveBeenCalledWith(error);

    const checkedOutClient = new EventEmitter();
    pool.emit("connect", checkedOutClient as never);
    expect(() => checkedOutClient.emit("error", error)).not.toThrow();
    expect(onPoolError).toHaveBeenCalledTimes(1);

    const checkedOutError = Object.assign(
      new Error("checked-out connection interrupted"),
      { code: "57P01" }
    );
    expect(() => checkedOutClient.emit("error", checkedOutError)).not.toThrow();
    expect(onPoolError).toHaveBeenLastCalledWith(checkedOutError);
    await pool.end();
  });

  it("exposes only a validated PostgreSQL error code", () => {
    expect(databaseErrorCode({ code: "57P01" })).toBe("57P01");
    expect(databaseErrorCode({ code: "connection secret" })).toBe("unknown");
    expect(databaseErrorCode(new Error("no structured code"))).toBe("unknown");
  });
});
