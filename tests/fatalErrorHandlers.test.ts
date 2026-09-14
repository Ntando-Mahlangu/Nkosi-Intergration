import { afterEach, describe, expect, it, vi } from "vitest";
import { installFatalErrorHandlers } from "../src/fatalErrorHandlers.js";

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

  it("logs and exits on an uncaught exception", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getListener = captureListener("uncaughtException");

    installFatalErrorHandlers("test-process");
    getListener()(new Error("boom"));

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      level: "error",
      message: "uncaught_exception",
      process: "test-process",
      error: "boom",
    });
  });

  it("logs and exits on an unhandled rejection, extracting the Error's message", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getListener = captureListener("unhandledRejection");

    installFatalErrorHandlers("test-process");
    getListener()(new Error("rejected"), Promise.resolve());

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ level: "error", message: "unhandled_rejection", error: "rejected" });
  });

  it("handles a non-Error rejection reason without throwing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getListener = captureListener("unhandledRejection");

    installFatalErrorHandlers("test-process");
    getListener()("just a string reason", Promise.resolve());

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.error).toBe("just a string reason");
  });
});
