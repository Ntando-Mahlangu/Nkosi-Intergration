import { describe, it, expect } from "vitest";
import { loadConfig } from "../server/app";

describe("deployment config", () => {
  it("uses Railway's public domain with https and secure cookies", () => {
    const c = loadConfig({ NODE_ENV: "production", RAILWAY_PUBLIC_DOMAIN: "csi-workspace-production.up.railway.app" });
    expect(c.publicUrl).toBe("https://csi-workspace-production.up.railway.app");
    expect(c.secureCookies).toBe(true);
  });
  it("PUBLIC_URL (e.g. a custom domain) wins over the platform domain", () => {
    expect(loadConfig({ PUBLIC_URL: "https://workspace.example.org", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" }).publicUrl).toBe("https://workspace.example.org");
  });
  it("never exposes a demo password in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).demoPassword).toBe("");
  });
});
