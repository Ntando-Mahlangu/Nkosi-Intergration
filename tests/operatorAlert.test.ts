import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// sendOperatorAlert goes through src/ssrf.ts's postToUntrustedUrl (not
// fetch) — mock node:dns/promises + node:http/node:https, matching the
// pattern used in tests/notify.test.ts and tests/ssrf.test.ts.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

interface FakeRequestOptions {
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, unknown>;
}
let nextStatusCode = 200;
let lastRequestBody = "";
let requestShouldError: Error | undefined;

function fakeRequest(_options: FakeRequestOptions, callback: (res: unknown) => void) {
  const req = new EventEmitter() as EventEmitter & { end: (body?: Buffer | string) => void; destroy: () => void };
  req.end = (body?: Buffer | string) => {
    if (body) lastRequestBody = body.toString();
    if (requestShouldError) {
      queueMicrotask(() => req.emit("error", requestShouldError));
      return;
    }
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
    res.statusCode = nextStatusCode;
    res.resume = () => {};
    queueMicrotask(() => {
      callback(res);
      res.emit("end");
    });
  };
  req.destroy = () => {};
  return req;
}

const httpRequestMock = vi.fn(fakeRequest);
const httpsRequestMock = vi.fn(fakeRequest);
vi.mock("node:http", () => ({
  default: { request: (...args: [FakeRequestOptions, (res: unknown) => void]) => httpRequestMock(...args) },
}));
vi.mock("node:https", () => ({
  default: { request: (...args: [FakeRequestOptions, (res: unknown) => void]) => httpsRequestMock(...args) },
}));

const { sendOperatorAlert } = await import("../src/operatorAlert.js");

describe("sendOperatorAlert", () => {
  const originalUrl = process.env.OPERATOR_ALERT_WEBHOOK_URL;

  beforeEach(() => {
    lookupMock.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    httpRequestMock.mockClear();
    httpsRequestMock.mockClear();
    nextStatusCode = 200;
    lastRequestBody = "";
    requestShouldError = undefined;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
    else process.env.OPERATOR_ALERT_WEBHOOK_URL = originalUrl;
  });

  it("does nothing when OPERATOR_ALERT_WEBHOOK_URL isn't set", async () => {
    delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
    await sendOperatorAlert("something broke");
    expect(lookupMock).not.toHaveBeenCalled();
    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("posts the message and details as JSON when configured", async () => {
    process.env.OPERATOR_ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
    await sendOperatorAlert("worker tick failed", { tenantId: "tenant-1" });

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(lastRequestBody);
    expect(body).toEqual({ text: "worker tick failed", tenantId: "tenant-1" });
  });

  it("never throws when the request errors", async () => {
    process.env.OPERATOR_ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
    requestShouldError = new Error("network down");
    await expect(sendOperatorAlert("something broke")).resolves.toBeUndefined();
  });

  it("never throws on a non-2xx response", async () => {
    process.env.OPERATOR_ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
    nextStatusCode = 500;
    await expect(sendOperatorAlert("something broke")).resolves.toBeUndefined();
  });

  it("never throws when the configured URL resolves to a private address (SSRF guard)", async () => {
    process.env.OPERATOR_ALERT_WEBHOOK_URL = "https://internal-looking.example.com/alert";
    lookupMock.mockReset().mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(sendOperatorAlert("something broke")).resolves.toBeUndefined();
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});
