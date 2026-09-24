# Texto SMS — Node.js / TypeScript SDK

Official SDK for the [Texto](https://texto.com.au) SMS API. Send SMS to
Australian and New Zealand numbers, read replies, manage sub-accounts, numbers,
credits, API keys, webhooks and reporting.

## Install

```bash
npm install @textoau/sdk
```

Requires Node.js 18 or newer.

## Quick start

```ts
import { Texto } from "@textoau/sdk";

const texto = new Texto({ apiKey: process.env.TEXTO_API_KEY! });

const result = await texto.messages.send({
  to: "+61400000000",
  message: "Your booking is confirmed for 2pm.",
});

console.log(result.message_id, result.credits_used);
```

CommonJS works too:

```js
const { Texto } = require("@textoau/sdk");
```

## Configuration

```ts
const texto = new Texto({
  apiKey: "txt_...",
  timeout: 30_000, // milliseconds, default 30000
  maxRetries: 2,   // retries for idempotent requests, default 2
});
```

`baseUrl` can be overridden, but only for pointing tests at a mock server or a
corporate proxy. The production API is always `https://api.texto.com.au`.

## Sending

```ts
// Single message
await texto.messages.send({
  to: "0400000000",
  message: "Hi Sam, your order has shipped.",
  sender: "TEXTO",       // optional dedicated number or approved Sender ID
  linkTracking: true,     // optional per-message override
  campaign: "Shipping",   // optional campaign name
});

// Up to 1,000 recipients, with merge data
// Tip: include {{OptOutLink}} in the message to add a unique per-recipient
// opt-out link (texto.au/xxxxxx, 15 chars, always shortened) — recommended
// for Sender ID sends, where recipients can't reply STOP.
await texto.messages.sendBatch({
  message: "Hi {name}, your appointment is {time}.",
  recipients: [
    { phone: "0400000001", merge_data: { name: "Sam", time: "2pm" } },
    { phone: "0400000002", merge_data: { name: "Alex", time: "3pm" } },
  ],
});

// Look up a message and its delivery receipt
const payload = await texto.messages.get(result.message_id);
console.log(payload.delivery_receipt?.status);
```

## Replies and opt-outs

```ts
const inbox = await texto.inbox.list({ limit: 50 });
const { optouts } = await texto.optouts.list();
```

## Credits, accounts and numbers

```ts
await texto.credits.balance();
await texto.accounts.list();
const sub = await texto.accounts.create({ businessName: "Acme Pty Ltd", email: "ops@acme.com.au" });
await texto.credits.allocate(sub.account_id, 500);
await texto.numbers.available({ country: "AU" });
await texto.numbers.purchase({ label: "Support line" });
```

Account, team and group endpoints require account hierarchy to be enabled on
your Texto account.

## Reporting

```ts
await texto.reports.get({ from: "2026-01-01", to: "2026-01-31", direction: "outbound" });
await texto.reports.group({ from: "2026-01-01" });
```

## Webhooks

```ts
import { parseWebhookEvent, isInboundEvent } from "@textoau/sdk";

app.post("/texto-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const event = parseWebhookEvent(
    req.body.toString("utf8"),
    req.header("X-Texto-Signature"),
    process.env.TEXTO_WEBHOOK_SECRET!,
  );

  if (isInboundEvent(event)) {
    console.log("Reply from", event.from, event.body);
  } else {
    console.log("Delivery status", event.delivery_receipt?.status);
  }

  res.sendStatus(200);
});
```

Always verify against the raw request body — re-serialised JSON will not match
the signature.

## Errors

```ts
import { TextoInsufficientCreditsError, TextoRateLimitError } from "@textoau/sdk";

try {
  await texto.messages.send({ to: "0400000000", message: "Hi" });
} catch (err) {
  if (err instanceof TextoInsufficientCreditsError) {
    console.log("Top up:", err.creditsRequired);
  } else if (err instanceof TextoRateLimitError) {
    console.log("Retry after", err.retryAfter);
  }
}
```

Every API error extends `TextoApiError` with `status`, `code` and `body`.
Network failures and timeouts throw `TextoConnectionError`.

## Support

- API reference: https://texto.com.au/developers
- Email: support@texto.com.au

## License

MIT © Floop Pty Ltd trading as Texto
