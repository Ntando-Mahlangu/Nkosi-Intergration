import type { Tenant } from "./types.js";

/** Sensible default if a tenant hasn't set explicit quiet hours: no sends 8pm-8am local time. */
export const DEFAULT_QUIET_HOURS = { startHour: 20, endHour: 8 } as const;

function localHour(timezone: string, now: Date): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).format(now);
  // "24" is returned for midnight by some ICU implementations; normalize to 0.
  return Number(formatted) % 24;
}

/**
 * True if `now` falls inside the tenant's configured quiet hours (in the
 * tenant's local timezone). Leads due for contact during quiet hours are
 * deferred to the next workflow run, never dropped or suppressed.
 */
export function isWithinQuietHours(tenant: Tenant, now: Date = new Date()): boolean {
  const window = tenant.quietHours ?? DEFAULT_QUIET_HOURS;
  const hour = localHour(tenant.timezone, now);

  if (window.startHour === window.endHour) return false; // zero-width window disables quiet hours

  if (window.startHour < window.endHour) {
    // e.g. startHour=9, endHour=17 -> quiet during the day (unusual, but valid config)
    return hour >= window.startHour && hour < window.endHour;
  }

  // Wraps midnight, e.g. startHour=20, endHour=8 -> quiet 8pm-8am
  return hour >= window.startHour || hour < window.endHour;
}
