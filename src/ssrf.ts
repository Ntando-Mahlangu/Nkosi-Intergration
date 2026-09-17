import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

// URL#hostname keeps the brackets around an IPv6 literal (e.g. "[::1]"),
// but net.isIP() only recognizes the bare form — strip them before any check.
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * A tenant sets notifyWebhookUrl themselves (via PATCH /tenants/me or the
 * admin API) and this server later does a real outbound POST to it
 * (src/notify.ts's deliverNotification) whenever a lead replies "interested"
 * or the chatbot escalates — both entirely lead/tenant-controlled triggers.
 * Without this check, a tenant (or anyone holding a leaked tenant API key)
 * could point notifyWebhookUrl at an internal address — a cloud metadata
 * endpoint (169.254.169.254), a database on the deployment's private
 * network, or localhost — and use this server as an SSRF proxy into
 * whatever network it runs on.
 */
function isPrivateOrReservedIp(ip: string, family: 4 | 6): boolean {
  if (family === 4) {
    const octets = ip.split(".").map(Number);
    const [a, b] = octets;
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true; // malformed — fail closed
    if (a === 127) return true; // loopback (127.0.0.0/8)
    if (a === 10) return true; // private (10.0.0.0/8)
    if (a === 172 && b >= 16 && b <= 31) return true; // private (172.16.0.0/12)
    if (a === 192 && b === 168) return true; // private (192.168.0.0/16)
    if (a === 169 && b === 254) return true; // link-local, incl. AWS/Azure/GCP metadata (169.254.0.0/16)
    if (a === 100 && b >= 64 && b <= 127) return true; // shared/CGNAT, incl. Alibaba Cloud metadata (100.64.0.0/10)
    if (a === 0) return true; // "this network" (0.0.0.0/8)
    if (a >= 224) return true; // multicast/reserved (224.0.0.0/4 and above)
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // link-local (fe80::/10)
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local (fc00::/7)
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 (e.g. "::ffff:169.254.169.254") — check the embedded IPv4.
    const embedded = lower.slice("::ffff:".length);
    return isIP(embedded) === 4 ? isPrivateOrReservedIp(embedded, 4) : true;
  }
  return false;
}

/**
 * node:dns/promises' lookup() has no built-in timeout — a hung/unreachable
 * resolver (misconfigured DNS, a network partition, a typo'd internal-only
 * domain) would otherwise block postToUntrustedUrl indefinitely. That's a
 * real problem for a caller like fatalErrorHandlers.ts, which awaits an
 * operator alert (src/operatorAlert.ts, itself built on this) before
 * calling process.exit(1) — an indefinite hang there would defeat the
 * entire point of that "last resort, must always eventually exit" handler.
 * `timeoutMs` bounds the DNS lookup and the HTTP request as two separate,
 * sequential phases (each gets its own fresh `timeoutMs` budget), so the
 * real worst case is up to roughly 2x `timeoutMs`, not `timeoutMs` — still
 * a hard bound (which is what matters here), just not as tight as the
 * parameter name alone suggests.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/** Synchronous, config-time-only check (no DNS lookup) — catches the obvious case immediately when a tenant saves a URL. */
export function isObviouslyUnsafeWebhookHostname(rawHostname: string): boolean {
  const hostname = stripBrackets(rawHostname);
  if (hostname.toLowerCase() === "localhost") return true;
  const literalFamily = isIP(hostname);
  return literalFamily ? isPrivateOrReservedIp(hostname, literalFamily as 4 | 6) : false;
}

export interface UntrustedPostResult {
  ok: boolean;
  status: number;
  /** True if the target responded with a 3xx — never followed (see postToUntrustedUrl). */
  redirected: boolean;
}

/**
 * POSTs JSON to an untrusted, tenant-controlled URL (notifyWebhookUrl) —
 * immune to DNS rebinding, unlike "check isSafeExternalHostname, then
 * fetch()": that pattern resolves the hostname twice (once to validate,
 * once inside fetch's own connection setup), and a rebinding DNS server
 * can answer those two lookups differently, sailing straight past the
 * check. This resolves the hostname exactly once, validates that single
 * result, and pins the actual TCP/TLS connection to that exact address via
 * the `lookup` option Node's http/https request implementation honors —
 * so the address that gets connected to is provably the one that was
 * validated. TLS servername/certificate validation still uses the
 * original hostname (Node's https.request only overrides where the
 * socket connects, not `servername`), so a legitimate HTTPS target is
 * unaffected. Never follows a redirect — reported via `redirected` instead
 * of being acted on, since a compromised/malicious target could otherwise
 * redirect this same request to an internal address.
 */
export async function postToUntrustedUrl(
  urlString: string,
  bodyText: string,
  timeoutMs = 10_000
): Promise<UntrustedPostResult> {
  const url = new URL(urlString);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }
  const hostname = stripBrackets(url.hostname);
  if (hostname.toLowerCase() === "localhost") {
    throw new Error("refusing to connect to localhost");
  }

  let pinnedAddress: string;
  let pinnedFamily: 4 | 6;
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isPrivateOrReservedIp(hostname, literalFamily as 4 | 6)) {
      throw new Error("refusing to connect to a private/reserved address");
    }
    pinnedAddress = hostname;
    pinnedFamily = literalFamily as 4 | 6;
  } else {
    const addresses = await withTimeout(
      lookup(hostname, { all: true }),
      timeoutMs,
      `DNS lookup for ${hostname} timed out after ${timeoutMs}ms`
    );
    const safe = addresses.find((a) => !isPrivateOrReservedIp(a.address, a.family as 4 | 6));
    if (!safe) throw new Error("refusing to connect: hostname has no public address");
    pinnedAddress = safe.address;
    pinnedFamily = safe.family as 4 | 6;
  }

  const client = url.protocol === "https:" ? https : http;
  const bodyBuffer = Buffer.from(bodyText, "utf8");

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: "POST",
        hostname: url.hostname, // used for the Host header and (https) TLS servername — not for the actual connection
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        path: url.pathname + url.search,
        headers: { "content-type": "application/json", "content-length": bodyBuffer.length },
        timeout: timeoutMs,
        // Pin the connection to the single address already validated above,
        // regardless of what hostname is asked for — this is what closes
        // the DNS-rebinding gap.
        lookup: (_hostname, _options, callback) => {
          callback(null, pinnedAddress, pinnedFamily);
        },
      },
      (res) => {
        res.resume(); // drain and discard the body — only the status is used
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, redirected: status >= 300 && status < 400 });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(bodyBuffer);
  });
}
