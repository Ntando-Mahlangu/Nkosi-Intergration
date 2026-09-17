import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { installFatalErrorHandlers } from "../src/fatalErrorHandlers.js";

// installFatalErrorHandlers fires a best-effort operator alert (see
// src/operatorAlert.ts) before exiting, which goes through src/ssrf.ts's
// postToUntrustedUrl (node:dns/promises + node:http/node:https, not fetch)
// — mock all three so the "alert configured" test below doesn't depend on
// real DNS/networking, matching the pattern used in tests/notify.test.ts.
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
let lastRequestBody = "";
function fakeRequest(_options: FakeRequestOptions, callback: (res: unknown) => void) {
  const req = new EventEmitter() as EventEmitter & { end: (body?: Buffer | string) => void; destroy: () => void };
  req.end = (body?: Buffer | string) => {
    if (body) lastRequestBody = body.toString();
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
    res.statusCode = 200;
    res.resume = () => {};
    queueMicrotask(() => {
      callback(res);
      res.emit("end");
    });
  };
  req.destroy = () => {};
  return req;
}
const httpsRequestMock = vi.fn(fakeRequest);
vi.mock("node:http", () => ({ default: { request: vi.fn(fakeRequest) } }));
vi.mock("node:https", () => ({
  default: { request: (...args: [FakeRequestOptions, (res: unknown) => void]) => httpsRequestMock(...args) },
}));

beforeEach(() => {
  lookupMock.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  httpsRequestMock.mockClear();
  lastRequestBody = "";
});

// Captures the registered listener via a spy on process.on and invokes it
// directly, rather than process.emit(...)-ing a real uncaughtException/
// unhandledRejection — actually emitting those would also trigger vitest's
// own process-level error reporting (it listens on the same events),
// polluting the test run's output even though nothing here actually failed.
function captureListener(event: "uncaughtException" | "unhandledRejection") {
  const onSpy = vi.spyOn(process, "on");
  return (): ((...args: unknown[]) => void) => {
    const call = onSpy.mock.calls.find((c) => c[0] === event);
    if (!call) throw new Error(`no listener registered for ${event}`);
    return call[1] as (...args: unknown[]) => void;
  };
}

describe("installFatalErrorHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // vi.spyOn(process, "on") without a mock implementation still calls
    // through to the real process.on, so each test genuinely registers a
    // listener on the real process object — clean those up too, or a later
    // test file's real uncaught error could trigger this test's "test-process"
    // handler (and its now-unmocked process.exit(1)) for real.
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
  });

  it("logs and exits on an uncaught exception", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getListener = captureListener("uncaughtException");

    installFatalErrorHandlers("test-process");
    getListener()(new Error("boom"));

    // Exit now happens after a best-effort operator alert attempt (a no-op
    // here — OPERATOR_ALERT_WEBHOOK_URL is unset — but still async), so it
    // no longer follows the listener call synchronously.
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      level: "error",
      message: "uncaught_exception",
      process: "test-process",
      error: "boom",
    });
  });

  it("logs and exits on an unhandled rejection, extracting the Error's message", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getListener = captureListener("unhandledRejection");

    installFatalErrorHandlers("test-process");
    getListener()(new Error("rejected"), Promise.resolve());

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ level: "error", message: "unhandled_rejection", error: "rejected" });
  });

  it("handles a non-Error rejection reason without throwing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getListener = captureListener("unhandledRejection");

    installFatalErrorHandlers("test-process");
    getListener()("just a string reason", Promise.resolve());

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.error).toBe("just a string reason");
  });

  it("posts a best-effort operator alert before exiting when OPERATOR_ALERT_WEBHOOK_URL is configured", async () => {
    const originalUrl = process.env.OPERATOR_ALERT_WEBHOOK_URL;
    process.env.OPERATOR_ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
    try {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const getListener = captureListener("uncaughtException");

      installFatalErrorHandlers("test-process");
      getListener()(new Error("boom"));

      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
      expect(httpsRequestMock).toHaveBeenCalled();
      const body = JSON.parse(lastRequestBody);
      expect(body.text).toContain("boom");
      expect(body.process).toBe("test-process");
    } finally {
      // In a finally (not just at the end of the try) so a thrown assertion
      // above still restores this — otherwise it'd leak into every later
      // test in this file, which would then unexpectedly hit the real
      // network-alert path instead of the no-op "unset" path they assume.
      if (originalUrl === undefined) delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
      else process.env.OPERATOR_ALERT_WEBHOOK_URL = originalUrl;
    }
  });
});
