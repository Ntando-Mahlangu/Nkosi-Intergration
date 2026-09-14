/**
 * The app's own publicly-reachable base URL (e.g. "https://leadrecovery.example.com"),
 * used to (a) reconstruct the exact URL Twilio signed for signature
 * verification — trusting req.protocol/req.get("host") instead is only
 * correct when the app is directly internet-facing, and silently breaks
 * signature verification behind a TLS-terminating proxy/load balancer that
 * doesn't forward the original scheme/host — and (b) build outbound
 * statusCallback URLs for delivery tracking. Unset in local/demo use.
 */
export function publicBaseUrl(): string | undefined {
  const raw = process.env.PUBLIC_BASE_URL;
  return raw ? raw.replace(/\/+$/, "") : undefined;
}
