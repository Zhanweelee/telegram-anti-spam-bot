import { describe, expect, it } from "vitest";
import { createApp, normalizeDeploymentMode } from "./index.js";

describe("worker", () => {
  const app = createApp();

  it("reports deployment mode from the binding", async () => {
    expect(normalizeDeploymentMode(undefined)).toBe("self-host");
    expect(normalizeDeploymentMode("nope")).toBe("self-host");
    expect(normalizeDeploymentMode("cloud")).toBe("cloud");

    const selfHost = await app.request(
      "/health",
      {},
      { DEPLOYMENT_MODE: "self-host" },
    );
    expect(await selfHost.json()).toEqual({
      ok: true,
      service: "tasb",
      deploymentMode: "self-host",
    });

    const cloud = await app.request(
      "/health",
      {},
      { DEPLOYMENT_MODE: "cloud" },
    );
    expect(await cloud.json()).toEqual({
      ok: true,
      service: "tasb",
      deploymentMode: "cloud",
    });

    const missing = await app.request("/health");
    expect(await missing.json()).toEqual({
      ok: true,
      service: "tasb",
      deploymentMode: "self-host",
    });
  });

  it("returns not_found for unknown routes", async () => {
    const response = await app.request("/nope", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "not_found" });
  });
});
