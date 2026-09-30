import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addressCreateMock = vi.fn();
const orderCreateMock = vi.fn();
const orderFetchMock = vi.fn();
const orderContextMock = vi.fn(() => ({ fetch: orderFetchMock }));
const twilioFactoryMock = vi.fn(() => ({
  addresses: { create: addressCreateMock },
  numbers: { v2: { hostedNumberOrders: Object.assign(orderContextMock, { create: orderCreateMock }) } },
}));

vi.mock("twilio", () => ({ default: twilioFactoryMock }));

const { startNumberHosting, refreshNumberHostingStatus, numberHostingConfigured, NUMBER_HOSTING_COMPLETE_STATUS } =
  await import("../src/numberHosting.js");

const ADDRESS = {
  customerName: "Acme Plumbing",
  street: "1 Main St",
  city: "Springfield",
  region: "IL",
  postalCode: "62704",
  isoCountry: "US",
};

describe("numberHosting", () => {
  const originalEnv = {
    sid: process.env.DEFAULT_TWILIO_ACCOUNT_SID,
    token: process.env.DEFAULT_TWILIO_AUTH_TOKEN,
  };

  beforeEach(() => {
    process.env.DEFAULT_TWILIO_ACCOUNT_SID = "AC_shared";
    process.env.DEFAULT_TWILIO_AUTH_TOKEN = "shared-token";
    addressCreateMock.mockReset();
    orderCreateMock.mockReset();
    orderFetchMock.mockReset();
    orderContextMock.mockClear();
    twilioFactoryMock.mockClear();
  });

  afterEach(() => {
    if (originalEnv.sid === undefined) delete process.env.DEFAULT_TWILIO_ACCOUNT_SID;
    else process.env.DEFAULT_TWILIO_ACCOUNT_SID = originalEnv.sid;
    if (originalEnv.token === undefined) delete process.env.DEFAULT_TWILIO_AUTH_TOKEN;
    else process.env.DEFAULT_TWILIO_AUTH_TOKEN = originalEnv.token;
  });

  describe("numberHostingConfigured", () => {
    it("is true once both shared Twilio env vars are set", () => {
      expect(numberHostingConfigured()).toBe(true);
    });

    it("is false when either is missing", () => {
      delete process.env.DEFAULT_TWILIO_AUTH_TOKEN;
      expect(numberHostingConfigured()).toBe(false);
    });
  });

  describe("startNumberHosting", () => {
    it("creates an address, then a hosted number order referencing it, and maps the result", async () => {
      addressCreateMock.mockResolvedValueOnce({ sid: "AD123" });
      orderCreateMock.mockResolvedValueOnce({
        sid: "HU123",
        phoneNumber: "+15551234567",
        status: "received",
        nextStep: "Wait for a verification call.",
        failureReason: null,
      });

      const result = await startNumberHosting({
        phoneNumber: "+15551234567",
        contactEmail: "owner@acme.com",
        address: ADDRESS,
      });

      expect(twilioFactoryMock).toHaveBeenCalledWith("AC_shared", "shared-token");
      expect(addressCreateMock).toHaveBeenCalledWith(ADDRESS);
      expect(orderCreateMock).toHaveBeenCalledWith({
        phoneNumber: "+15551234567",
        contactPhoneNumber: "+15551234567",
        addressSid: "AD123",
        email: "owner@acme.com",
        smsCapability: true,
      });
      expect(result).toEqual({
        orderSid: "HU123",
        phoneNumber: "+15551234567",
        status: "received",
        nextStep: "Wait for a verification call.",
        failureReason: undefined,
      });
    });

    it("throws a clear error when the shared Twilio account isn't configured", async () => {
      delete process.env.DEFAULT_TWILIO_ACCOUNT_SID;
      delete process.env.DEFAULT_TWILIO_AUTH_TOKEN;

      await expect(
        startNumberHosting({ phoneNumber: "+15551234567", contactEmail: "owner@acme.com", address: ADDRESS })
      ).rejects.toThrow(/shared agency Twilio account/);
      expect(addressCreateMock).not.toHaveBeenCalled();
    });
  });

  describe("refreshNumberHostingStatus", () => {
    it("fetches the order by sid and maps the result", async () => {
      orderFetchMock.mockResolvedValueOnce({
        sid: "HU123",
        phoneNumber: "+15551234567",
        status: NUMBER_HOSTING_COMPLETE_STATUS,
        nextStep: "",
        failureReason: "",
      });

      const result = await refreshNumberHostingStatus("HU123");

      expect(orderContextMock).toHaveBeenCalledWith("HU123");
      expect(result.status).toBe("completed");
      expect(result.nextStep).toBeUndefined();
      expect(result.failureReason).toBeUndefined();
    });
  });
});
