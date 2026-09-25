/**
 * Current version of LeadRecovery's own Terms of Service / Privacy Policy
 * (the actual text lives in public/terms.html and public/privacy.html,
 * which is what a client actually reads). `POST /tenants/me/accept-terms`
 * only accepts this exact string, so a client can't silently "accept" a
 * version this deployment doesn't currently offer — bump it (and update
 * those two pages) whenever a material change means existing acceptances
 * shouldn't silently carry over.
 */
export const CURRENT_TERMS_VERSION = "2026-09-25";
