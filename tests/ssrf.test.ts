import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// postToUntrustedUrl uses node:http/node:https directly (not fetch) so it
// can pin the actual connection to a single validated address — mock both
// modules' `request` to capture what it asked for and drive a fake response,
// without any real networking.
interface FakeRequestOptions {
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, unknown>;
  lookup?: (
    hostname: string,
    options: unknown,
    cb: (err: Error | null, address?: string, family?: number) => void
  ) => void;
}
let nextStatusCode = 200;
let lastRequestOptions: FakeRequestOptions | undefined;
let lastRequestBody = "";
let requestShouldError: Error | undefined;

function fakeRequest(options: FakeRequestOptions, callback: (res: unknown) => void) {
  lastRequestOptions = options;
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

const { isObviouslyUnsafeWebhookHostname, postToUntrustedUrl } = await import("../src/ssrf.js");

beforeEach(() => {
  nextStatusCode = 200;
  lastRequestOptions = undefined;
  lastRequestBody = "";
  requestShouldError = undefined;
  lookupMock.mockClear();
  httpRequestMock.mockClear();
  httpsRequestMock.mockClear();
});

describe("isObviouslyUnsafeWebhookHostname (synchronous, config-time check)", () => {
  it("rejects localhost", () => {
    expect(isObviouslyUnsafeWebhookHostname("localhost")).toBe(true);
    expect(isObviouslyUnsafeWebhookHostname("LOCALHOST")).toBe(true);
  });

  it("rejects private/reserved IPv4 literals", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
    ]) {
      expect(isObviouslyUnsafeWebhookHostname(ip), ip).toBe(true);
    }
  });

  it("rejects the shared/CGNAT range 100.64.0.0/10, incl. Alibaba Cloud's metadata endpoint", () => {
    expect(isObviouslyUnsafeWebhookHostname("100.100.100.200")).toBe(true); // Alibaba Cloud metadata
    expect(isObviouslyUnsafeWebhookHostname("100.64.0.1")).toBe(true);
    expect(isObviouslyUnsafeWebhookHostname("100.127.255.255")).toBe(true);
    expect(isObviouslyUnsafeWebhookHostname("100.63.255.255")).toBe(false); // just outside the range
    expect(isObviouslyUnsafeWebhookHostname("100.128.0.0")).toBe(false); // just outside the range
  });

  it("rejects IPv6 loopback/link-local/unique-local literals, bracketed or not", () => {
    expect(isObviouslyUnsafeWebhookHostname("::1")).toBe(true);
    expect(isObviouslyUnsafeWebhookHostname("[::1]")).toBe(true);
    expect(isObviouslyUnsafeWebhookHostname("fe80::1")).toBe(true);
    expect(isObviouslyUnsafeWebhookHostname("fd00::1")).toBe(true);
  });

  it("rejects an IPv4-mapped IPv6 literal wrapping a private address", () => {
    expect(isObviouslyUnsafeWebhookHostname("::ffff:169.254.169.254")).toBe(true);
  });

  it("allows a public IPv4 literal", () => {
    expect(isObviouslyUnsafeWebhookHostname("8.8.8.8")).toBe(false);
  });

  it("allows an ordinary hostname (no DNS lookup happens here)", () => {
    expect(isObviouslyUnsafeWebhookHostname("hooks.example.com")).toBe(false);
  });
});

describe("postToUntrustedUrl (delivery-time: resolve once, pin the connection, no redirects)", () => {
  it("rejects localhost without a DNS lookup or any request", async () => {
    await expect(postToUntrustedUrl("http://localhost/hook", "{}")).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("rejects a literal private IP without a DNS lookup or any request", async () => {
    await expect(postToUntrustedUrl("http://10.0.0.5/hook", "{}")).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves only to a private address (DNS rebinding / attacker-controlled DNS), without ever requesting", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(postToUntrustedUrl("http://attacker-controlled.example.com/hook", "{}")).rejects.toThrow();
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("pins the connection to the exact resolved address instead of letting the request layer re-resolve it", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const result = await postToUntrustedUrl("http://hooks.example.com/notify?x=1", '{"a":1}');

    expect(result).toEqual({ ok: true, status: 200, redirected: false });
    expect(lastRequestOptions?.hostname).toBe("hooks.example.com"); // Host header / TLS servername — not the connection target
    expect(lastRequestOptions?.path).toBe("/notify?x=1");
    expect(lastRequestOptions?.method).toBe("POST");
    expect(lastRequestBody).toBe('{"a":1}');

    // The pinned `lookup` option always returns the one address already
    // validated above, regardless of what hostname is asked for — this is
    // what makes a second, independent (and potentially different) DNS
    // answer impossible for this request.
    const pinnedLookup = lastRequestOptions?.lookup;
    expect(pinnedLookup).toBeTypeOf("function");
    const cb = vi.fn();
    pinnedLookup?.("literally-anything.invalid", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("uses https.request for an https:// URL", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    await postToUntrustedUrl("https://hooks.example.com/notify", "{}");
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("does not treat a literal public IP as needing a redirect check to succeed", async () => {
    const result = await postToUntrustedUrl("http://93.184.216.34/hook", "{}");
    expect(result.ok).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled(); // literal IP — no DNS needed
  });

  it("reports a non-2xx status without throwing", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    nextStatusCode = 500;
    const result = await postToUntrustedUrl("http://hooks.example.com/notify", "{}");
    expect(result).toEqual({ ok: false, status: 500, redirected: false });
  });

  it("reports a 3xx as redirected rather than following it", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    nextStatusCode = 302;
    const result = await postToUntrustedUrl("http://hooks.example.com/notify", "{}");
    expect(result).toEqual({ ok: false, status: 302, redirected: true });
  });

  it("rejects if the underlying request errors", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    requestShouldError = new Error("ECONNREFUSED");
    await expect(postToUntrustedUrl("http://hooks.example.com/notify", "{}")).rejects.toThrow("ECONNREFUSED");
  });
});
