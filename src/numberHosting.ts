import twilio from "twilio";

/**
 * "Connect a client's existing number" — the same mechanism a missed-call/
 * AI-receptionist product (missedcall.io, etc.) uses: instead of assigning
 * the client a brand new number from the agency's Twilio pool, this hosts
 * SMS capability for the number they already give out to customers, on the
 * agency's own shared Twilio account (see src/channelDefaults.ts).
 *
 * Ownership/consent is proven the way Twilio's Hosted Number Orders product
 * actually does it: Twilio places an automated verification call to the
 * number, and the person who answers confirms it live on that call — no
 * separate "enter this code" step happens in our own app, Twilio's own IVR
 * handles it. After that, Twilio still needs to carrier-process the order
 * (and, depending on the number's current carrier, may require the contact
 * to e-sign a Letter of Authorization emailed to them) before status reaches
 * "completed" — that step can take real time (Twilio's own docs describe
 * hours to several business days) and isn't something any app, including
 * ours, can shortcut.
 */

export interface NumberHostingAddress {
  /** The business name/legal entity this number is registered to. */
  customerName: string;
  street: string;
  city: string;
  /** State/province. */
  region: string;
  postalCode: string;
  /** Two-letter country code, e.g. "US". */
  isoCountry: string;
}

export interface StartNumberHostingInput {
  /** The client's existing number, in E.164 format (e.g. +15551234567) — this is what gets hosted, not a new number. */
  phoneNumber: string;
  /** Where Twilio sends order status updates and (if required) the Letter of Authorization to sign. */
  contactEmail: string;
  address: NumberHostingAddress;
}

export interface NumberHostingResult {
  orderSid: string;
  phoneNumber: string;
  status: string;
  /** Twilio's own description of what happens next (e.g. "Wait for a phone call to verify ownership of this number."). */
  nextStep?: string;
  /** Only set once status is "action-required" or "failed". */
  failureReason?: string;
}

function getSharedTwilioClient() {
  const accountSid = process.env.DEFAULT_TWILIO_ACCOUNT_SID;
  const authToken = process.env.DEFAULT_TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error(
      "Connecting a client's existing number uses the shared agency Twilio account — " +
        "set DEFAULT_TWILIO_ACCOUNT_SID/DEFAULT_TWILIO_AUTH_TOKEN first."
    );
  }
  return twilio(accountSid, authToken);
}

export function numberHostingConfigured(): boolean {
  return Boolean(process.env.DEFAULT_TWILIO_ACCOUNT_SID && process.env.DEFAULT_TWILIO_AUTH_TOKEN);
}

/**
 * Kicks off hosting: registers the business's address with Twilio (required
 * for the regulatory record every hosted number order needs), then opens the
 * order itself for the client's number. Twilio takes it from here — the
 * verification call typically follows within minutes.
 */
export async function startNumberHosting(input: StartNumberHostingInput): Promise<NumberHostingResult> {
  const client = getSharedTwilioClient();
  const address = await client.addresses.create({
    customerName: input.address.customerName,
    street: input.address.street,
    city: input.address.city,
    region: input.address.region,
    postalCode: input.address.postalCode,
    isoCountry: input.address.isoCountry,
  });
  const order = await client.numbers.v2.hostedNumberOrders.create({
    phoneNumber: input.phoneNumber,
    contactPhoneNumber: input.phoneNumber,
    addressSid: address.sid,
    email: input.contactEmail,
    smsCapability: true,
  });
  return {
    orderSid: order.sid,
    phoneNumber: order.phoneNumber,
    status: order.status,
    nextStep: order.nextStep || undefined,
    failureReason: order.failureReason || undefined,
  };
}

/** Re-fetches the current status of an in-progress order from Twilio. */
export async function refreshNumberHostingStatus(orderSid: string): Promise<NumberHostingResult> {
  const client = getSharedTwilioClient();
  const order = await client.numbers.v2.hostedNumberOrders(orderSid).fetch();
  return {
    orderSid: order.sid,
    phoneNumber: order.phoneNumber,
    status: order.status,
    nextStep: order.nextStep || undefined,
    failureReason: order.failureReason || undefined,
  };
}

/** The only status meaning Twilio has fully activated SMS for this number — see Tenant.numberHostingOrder. */
export const NUMBER_HOSTING_COMPLETE_STATUS = "completed";
