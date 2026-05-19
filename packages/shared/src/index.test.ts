import { describe, expect, it } from "vitest";
import { configFlagEnabled, createHealth, requireEnv } from "./index.js";

describe("createHealth", () => {
  it("creates an ok health payload", () => {
    expect(createHealth("test").status).toBe("ok");
  });
});

describe("configFlagEnabled", () => {
  it("parses common truthy flag values", () => {
    expect(configFlagEnabled("true")).toBe(true);
    expect(configFlagEnabled(" YES ")).toBe(true);
    expect(configFlagEnabled("0")).toBe(false);
  });
});

describe("requireEnv", () => {
  it("throws for missing required values", () => {
    expect(() => requireEnv(["DATABASE_URL", "API_TOKEN_PEPPER"], {})).toThrow(
      "DATABASE_URL, API_TOKEN_PEPPER"
    );
  });

  it("allows present required values", () => {
    expect(() =>
      requireEnv(["DATABASE_URL"], { DATABASE_URL: "postgres://db" })
    ).not.toThrow();
  });
});
