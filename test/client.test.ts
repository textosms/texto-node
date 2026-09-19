import { describe, expect, it, vi } from "vitest";
import { Texto } from "../src/client.js";
import { TextoAuthenticationError, TextoInsufficientCreditsError } from "../src/errors.js";
import { verifyWebhookSignature } from "../src/webhooks.js";
import { createHmac } from "node:crypto";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Texto client", () => {
  it("sends a message with bearer auth and snake_case body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message_id: "m1", credits_used: 1 }));
    const texto = new Texto({ apiKey: "txt_test", fetch: fetchMock as unknown as typeof fetch });

    const res = await texto.messages.send({
      to: "+61400000000",
      message: "Hello",
      linkTracking: true,
    });

    expect(res.message_id).toBe("m1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.texto.com.au/send");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer txt_test");
    expect(JSON.parse(init.body as string)).toEqual({
      to: "+61400000000",
      message: "Hello",
      link_tracking: true,
    });
  });

  it("builds query strings for reports", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ from: "a", to: "b" }));
    const texto = new Texto({ apiKey: "txt_test", fetch: fetchMock as unknown as typeof fetch });

    await texto.reports.get({ from: "2026-01-01", direction: "outbound" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/report?from=2026-01-01&direction=outbound");
  });

  it("throws typed errors", async () => {
    const texto = new Texto({
      apiKey: "txt_test",
      fetch: (async () => jsonResponse({ error: "Invalid API key" }, 401)) as unknown as typeof fetch,
    });
    await expect(texto.credits.balance()).rejects.toBeInstanceOf(TextoAuthenticationError);
  });

  it("exposes credit details on 402", async () => {
    const texto = new Texto({
      apiKey: "txt_test",
      fetch: (async () =>
        jsonResponse({ error: "Insufficient credits", credits_required: 5, credits_available: 1 }, 402)) as unknown as typeof fetch,
    });
    await expect(texto.messages.send({ to: "+61400000000", message: "hi" })).rejects.toMatchObject({
      name: "TextoInsufficientCreditsError",
      creditsRequired: 5,
    });
    await expect(
      texto.messages.send({ to: "+61400000000", message: "hi" }),
    ).rejects.toBeInstanceOf(TextoInsufficientCreditsError);
  });

  it("retries retryable GET failures", async () => {
    let calls = 0;
    const texto = new Texto({
      apiKey: "txt_test",
      maxRetries: 1,
      fetch: (async () => {
        calls++;
        return calls === 1 ? jsonResponse({ error: "boom" }, 503) : jsonResponse({ credits: 10 });
      }) as unknown as typeof fetch,
    });
    await expect(texto.credits.balance()).resolves.toEqual({ credits: 10 });
    expect(calls).toBe(2);
  });

  it("does not retry POST without an idempotency key", async () => {
    let calls = 0;
    const texto = new Texto({
      apiKey: "txt_test",
      fetch: (async () => {
        calls++;
        return jsonResponse({ error: "boom" }, 503);
      }) as unknown as typeof fetch,
    });
    await expect(texto.messages.send({ to: "+61400000000", message: "hi" })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("webhook signatures", () => {
  it("verifies a valid signature", () => {
    const body = JSON.stringify({ event: "message.inbound" });
    const sig = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig, "secret")).toBe(true);
    expect(verifyWebhookSignature(body, sig, "other")).toBe(false);
    expect(verifyWebhookSignature(body, null, "secret")).toBe(false);
  });
});
