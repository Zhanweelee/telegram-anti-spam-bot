import { Hono } from "hono";

export type DeploymentMode = "self-host" | "cloud";

export type WorkerBindings = {
  DEPLOYMENT_MODE?: string;
};

export function normalizeDeploymentMode(
  value: string | undefined,
): DeploymentMode {
  return value === "cloud" ? "cloud" : "self-host";
}

export function createApp(): Hono<{ Bindings: WorkerBindings }> {
  const app = new Hono<{ Bindings: WorkerBindings }>();

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "tasb",
      deploymentMode: normalizeDeploymentMode(c.env?.DEPLOYMENT_MODE),
    });
  });

  app.all("*", (c) => c.json({ ok: false, error: "not_found" }, 404));
  return app;
}

const app = createApp();

export default app;
