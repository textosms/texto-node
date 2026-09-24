import { TextoConnectionError, errorFromResponse } from "./errors.js";
import type {
  AccessSettings,
  AccountDetail,
  AccountReport,
  AccountSummary,
  AccountUser,
  ApiKey,
  AvailableNumbersResponse,
  BalanceResponse,
  CampaignResponse,
  CreateAccountParams,
  CreateAccountResponse,
  CreatedApiKey,
  CreditTransferResponse,
  DeleteAccountResponse,
  GroupReport,
  InboxParams,
  InboxResponse,
  InviteUserParams,
  InviteUserResponse,
  MessagePayload,
  OkResponse,
  OptoutsResponse,
  PurchaseNumberParams,
  PurchasedNumber,
  ReportParams,
  SendBatchParams,
  SendBatchResponse,
  SendParams,
  SendResponse,
  SetAccessParams,
  StatusResponse,
  TeamMember,
  TextoNumber,
  UpdateAccountParams,
  UpdateAccountResponse,
  WebhookEndpoint,
  WebhookUpsertParams,
  WebhooksResponse,
} from "./types.js";

export interface TextoOptions {
  /** Your Texto API key, beginning `txt_`. */
  apiKey: string;
  /**
   * API base URL. Defaults to the Texto production API. Override only to point
   * the client at a mock server or a corporate proxy during testing.
   */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** How many times to retry a retryable failure. Defaults to 2. */
  maxRetries?: number;
  /** Supply a custom fetch implementation (for tests or proxies). */
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Retry even though the method is not idempotent. */
  idempotencyKey?: string;
}

const DEFAULT_BASE_URL = "https://api.texto.com.au";
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Client for the Texto SMS API.
 *
 * ```ts
 * const texto = new Texto({ apiKey: process.env.TEXTO_API_KEY! });
 * await texto.messages.send({ to: "+61400000000", message: "Hello" });
 * ```
 */
export class Texto {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TextoOptions) {
    if (!options?.apiKey) {
      throw new Error("A Texto API key is required. Pass { apiKey } to the client.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("No fetch implementation available. Use Node 18+ or pass { fetch }.");
    }
  }

  /** Perform a raw request against the API. Exposed for endpoints not yet wrapped. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": "texto-node/1.0.0",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const isIdempotent = method === "GET" || method === "PUT" || method === "DELETE";
    const retries = isIdempotent || options.idempotencyKey ? this.maxRetries : 0;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(2 ** attempt * 250, 4_000));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
      } catch (err) {
        lastError = new TextoConnectionError(
          controller.signal.aborted
            ? `Request to ${path} timed out after ${this.timeout}ms`
            : `Request to ${path} failed`,
          err,
        );
        if (attempt < retries) continue;
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: text };
        }
      }

      if (response.ok) return parsed as T;

      if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
        lastError = errorFromResponse(response.status, parsed);
        continue;
      }

      const retryAfterHeader = response.headers.get("retry-after");
      throw errorFromResponse(
        response.status,
        parsed,
        response.headers.get("x-request-id") ?? undefined,
        retryAfterHeader ? Number(retryAfterHeader) : undefined,
      );
    }

    throw lastError ?? new TextoConnectionError(`Request to ${path} failed`);
  }

  // ── Status ──────────────────────────────────────────────────────────

  /** Public health check. Does not consume credits. */
  status(): Promise<StatusResponse> {
    return this.request<StatusResponse>("GET", "/status");
  }

  // ── Messaging ───────────────────────────────────────────────────────

  readonly messages = {
    /**
     * Send a single SMS.
     *
     * Include `{{OptOutLink}}` in the message to insert a unique per-recipient
     * opt-out link (`texto.au/xxxxxx`, 15 characters). It always shortens,
     * independent of link tracking, and is the recommended opt-out mechanism
     * for Sender ID sends, where recipients cannot reply STOP.
     */
    send: (params: SendParams): Promise<SendResponse> =>
      this.request<SendResponse>("POST", "/send", {
        body: omitUndefined({
          to: params.to,
          message: params.message,
          sender: params.sender,
          link_tracking: params.linkTracking,
          campaign: params.campaign,
        }),
      }),

    /**
     * Send the same message to up to 1,000 recipients, with optional merge data.
     *
     * Merge fields use `{{key}}` syntax; `{{SendingNumber}}` is always
     * available. Include `{{OptOutLink}}` to insert a unique per-recipient
     * opt-out link (always shortened to 15 characters) — recommended for
     * Sender ID sends, where recipients cannot reply STOP.
     */
    sendBatch: (params: SendBatchParams): Promise<SendBatchResponse> =>
      this.request<SendBatchResponse>("POST", "/send-batch", {
        body: omitUndefined({
          recipients: params.recipients,
          message: params.message,
          sender: params.sender,
          link_tracking: params.linkTracking,
          campaign: params.campaign,
        }),
      }),

    /** Fetch a message and its delivery receipt by id or idempotency key. */
    get: (messageId: string): Promise<MessagePayload> =>
      this.request<MessagePayload>("GET", `/message/${encodeURIComponent(messageId)}`),

    /** Fetch a campaign with its per-message results. */
    campaign: (
      campaignId: string,
      params: { limit?: number; offset?: number } = {},
    ): Promise<CampaignResponse> =>
      this.request<CampaignResponse>("GET", `/campaign/${encodeURIComponent(campaignId)}`, {
        query: { limit: params.limit, offset: params.offset },
      }),
  };

  // ── Inbox and opt-outs ──────────────────────────────────────────────

  readonly inbox = {
    /** List inbound (reply) messages. */
    list: (params: InboxParams = {}): Promise<InboxResponse> =>
      this.request<InboxResponse>("GET", "/inbox", {
        query: {
          limit: params.limit,
          offset: params.offset,
          from: params.from,
          date_from: params.dateFrom,
          date_to: params.dateTo,
        },
      }),
  };

  readonly optouts = {
    /** List numbers that have opted out, including global opt-outs. */
    list: (): Promise<OptoutsResponse> => this.request<OptoutsResponse>("GET", "/optouts"),
  };

  // ── Credits ─────────────────────────────────────────────────────────

  readonly credits = {
    /** Current credit balance for the calling account. */
    balance: (): Promise<BalanceResponse> => this.request<BalanceResponse>("GET", "/balance"),

    /** Credit balance for a sub-account. */
    accountBalance: (accountId: string): Promise<BalanceResponse> =>
      this.request<BalanceResponse>("GET", `/account/${encodeURIComponent(accountId)}/balance`),

    /** Move credits from the calling account down to a sub-account. */
    allocate: (accountId: string, amount: number): Promise<CreditTransferResponse> =>
      this.request<CreditTransferResponse>(
        "POST",
        `/account/${encodeURIComponent(accountId)}/credits/allocate`,
        { body: { amount } },
      ),

    /** Pull credits back from a sub-account. */
    recall: (accountId: string, amount: number): Promise<CreditTransferResponse> =>
      this.request<CreditTransferResponse>(
        "POST",
        `/account/${encodeURIComponent(accountId)}/credits/recall`,
        { body: { amount } },
      ),
  };

  // ── Accounts ────────────────────────────────────────────────────────

  readonly accounts = {
    /** List the calling account and its sub-accounts. */
    list: async (): Promise<AccountSummary[]> => {
      const res = await this.request<{ accounts: AccountSummary[] }>("GET", "/accounts");
      return res.accounts;
    },

    /** Create a sub-account. */
    create: (params: CreateAccountParams): Promise<CreateAccountResponse> =>
      this.request<CreateAccountResponse>("POST", "/accounts", {
        body: omitUndefined({
          business_name: params.businessName,
          email: params.email,
          daily_limit: params.dailyLimit,
          managed_by_parent: params.managedByParent,
          team_access_from_parent: params.teamAccessFromParent,
          optout_exempt: params.optoutExempt,
          seed_credits: params.seedCredits,
          inherit_parent_senders: params.inheritParentSenders,
        }),
      }),

    /** Fetch full detail for an account. */
    get: async (accountId: string): Promise<AccountDetail> => {
      const res = await this.request<{ account: AccountDetail }>(
        "GET",
        `/account/${encodeURIComponent(accountId)}`,
      );
      return res.account;
    },

    /** Update a sub-account. */
    update: (accountId: string, params: UpdateAccountParams): Promise<UpdateAccountResponse> =>
      this.request<UpdateAccountResponse>("PATCH", `/account/${encodeURIComponent(accountId)}`, {
        body: omitUndefined({
          business_name: params.businessName,
          daily_limit: params.dailyLimit,
          optout_exempt: params.optoutExempt,
          team_access_from_parent: params.teamAccessFromParent,
          inherit_parent_senders: params.inheritParentSenders,
        }),
      }),

    /** Schedule a sub-account for deletion. */
    delete: (accountId: string): Promise<DeleteAccountResponse> =>
      this.request<DeleteAccountResponse>("DELETE", `/account/${encodeURIComponent(accountId)}`),

    /** Report for a specific account in the hierarchy. */
    report: (accountId: string, params: ReportParams = {}): Promise<AccountReport> =>
      this.request<AccountReport>("GET", `/account/${encodeURIComponent(accountId)}/report`, {
        query: reportQuery(params),
      }),
  };

  // ── Users and access ────────────────────────────────────────────────

  readonly users = {
    /** Team members on the calling account. */
    listTeam: async (): Promise<TeamMember[]> => {
      const res = await this.request<{ users: TeamMember[] }>("GET", "/team");
      return res.users;
    },

    /** Team members on a specific account, including inherited ones. */
    list: async (accountId: string): Promise<AccountUser[]> => {
      const res = await this.request<{ users: AccountUser[] }>(
        "GET",
        `/account/${encodeURIComponent(accountId)}/users`,
      );
      return res.users;
    },

    /** Invite a person to an account. */
    invite: (accountId: string, params: InviteUserParams): Promise<InviteUserResponse> =>
      this.request<InviteUserResponse>("POST", `/account/${encodeURIComponent(accountId)}/users`, {
        body: omitUndefined({
          email: params.email,
          name: params.name,
          can_send: params.canSend,
          can_billing: params.canBilling,
        }),
      }),

    /** Remove a team member. Pass the member row id from the users list. */
    remove: (accountId: string, memberId: string): Promise<OkResponse> =>
      this.request<OkResponse>(
        "DELETE",
        `/account/${encodeURIComponent(accountId)}/users/${encodeURIComponent(memberId)}`,
      ),
  };

  readonly access = {
    /** Read parent-management and inherited-team settings for an account. */
    get: (accountId: string): Promise<AccessSettings> =>
      this.request<AccessSettings>("GET", `/account/${encodeURIComponent(accountId)}/access`),

    /** Update parent-management and inherited-team settings for an account. */
    set: (accountId: string, params: SetAccessParams): Promise<OkResponse> =>
      this.request<OkResponse>("PUT", `/account/${encodeURIComponent(accountId)}/access`, {
        body: omitUndefined({
          managed_by_parent: params.managedByParent,
          team_access_from_parent: params.teamAccessFromParent,
        }),
      }),
  };

  // ── API keys ────────────────────────────────────────────────────────

  readonly keys = {
    /** List API keys on an account. Key values are never returned. */
    list: async (accountId: string): Promise<ApiKey[]> => {
      const res = await this.request<{ keys: ApiKey[] }>(
        "GET",
        `/account/${encodeURIComponent(accountId)}/keys`,
      );
      return res.keys;
    },

    /** Create an API key. The full value is returned once — store it securely. */
    create: (accountId: string, name: string): Promise<CreatedApiKey> =>
      this.request<CreatedApiKey>("POST", `/account/${encodeURIComponent(accountId)}/key`, {
        body: { name },
      }),

    /** Revoke an API key. */
    revoke: (accountId: string, keyId: string): Promise<OkResponse> =>
      this.request<OkResponse>(
        "DELETE",
        `/account/${encodeURIComponent(accountId)}/key/${encodeURIComponent(keyId)}`,
      ),
  };

  // ── Numbers ─────────────────────────────────────────────────────────

  readonly numbers = {
    /** Numbers owned by the calling account. */
    list: async (): Promise<TextoNumber[]> => {
      const res = await this.request<{ numbers: TextoNumber[] }>("GET", "/numbers");
      return res.numbers;
    },

    /** Numbers across the calling account and all its sub-accounts. */
    listGroup: async (): Promise<TextoNumber[]> => {
      const res = await this.request<{ numbers: TextoNumber[] }>("GET", "/numbers/group");
      return res.numbers;
    },

    /** Numbers assigned to a specific account. */
    listForAccount: async (accountId: string): Promise<TextoNumber[]> => {
      const res = await this.request<{ numbers: TextoNumber[] }>(
        "GET",
        `/account/${encodeURIComponent(accountId)}/numbers`,
      );
      return res.numbers;
    },

    /** Numbers currently available to purchase. */
    available: (
      params: { country?: "AU" | "NZ"; limit?: number; offset?: number } = {},
    ): Promise<AvailableNumbersResponse> =>
      this.request<AvailableNumbersResponse>("GET", "/numbers/available", {
        query: { country: params.country, limit: params.limit, offset: params.offset },
      }),

    /** Purchase a dedicated number. Charges the card saved on the account. */
    purchase: (params: PurchaseNumberParams = {}): Promise<PurchasedNumber> =>
      this.request<PurchasedNumber>("POST", "/numbers/purchase", {
        body: omitUndefined({
          number: params.number,
          label: params.label,
          country: params.country,
        }),
      }),

    /** Assign parent-owned numbers to a sub-account. */
    assign: (accountId: string, numbers: string | string[]): Promise<OkResponse & { assigned?: unknown }> =>
      this.request("POST", `/account/${encodeURIComponent(accountId)}/numbers/assign`, {
        body: { numbers },
      }),

    /** Recall numbers from a sub-account. */
    recall: (accountId: string, numbers: string | string[]): Promise<OkResponse & { recalled?: unknown }> =>
      this.request("POST", `/account/${encodeURIComponent(accountId)}/numbers/recall`, {
        body: { numbers },
      }),
  };

  // ── Webhooks ────────────────────────────────────────────────────────

  readonly webhooks = {
    /** Read the configured delivery receipt and inbound webhooks. */
    get: (): Promise<WebhooksResponse> => this.request<WebhooksResponse>("GET", "/webhooks"),

    /** Create or update the delivery receipt webhook. */
    setDelivery: async (params: WebhookUpsertParams): Promise<WebhookEndpoint> => {
      const res = await this.request<{ delivery_receipt: WebhookEndpoint }>("PUT", "/webhooks/delivery", {
        body: omitUndefined({ url: params.url, enabled: params.enabled }),
      });
      return res.delivery_receipt;
    },

    /** Create or update the inbound message webhook. */
    setInbound: async (params: WebhookUpsertParams): Promise<WebhookEndpoint> => {
      const res = await this.request<{ inbound: WebhookEndpoint }>("PUT", "/webhooks/inbound", {
        body: omitUndefined({ url: params.url, enabled: params.enabled }),
      });
      return res.inbound;
    },

    /** Rotate the delivery receipt signing secret. Returned once. */
    rotateDeliverySecret: async (): Promise<string> => {
      const res = await this.request<{ secret: string }>("POST", "/webhooks/delivery");
      return res.secret;
    },

    /** Rotate the inbound signing secret. Returned once. */
    rotateInboundSecret: async (): Promise<string> => {
      const res = await this.request<{ secret: string }>("POST", "/webhooks/inbound");
      return res.secret;
    },
  };

  // ── Reporting ───────────────────────────────────────────────────────

  readonly reports = {
    /** Report for the calling account. */
    get: (params: ReportParams = {}): Promise<AccountReport> =>
      this.request<AccountReport>("GET", "/report", { query: reportQuery(params) }),

    /** Report across the calling account and all its sub-accounts. */
    group: (params: { from?: string; to?: string } = {}): Promise<GroupReport> =>
      this.request<GroupReport>("GET", "/report/group", {
        query: { from: params.from, to: params.to },
      }),
  };
}

function reportQuery(params: ReportParams): Record<string, unknown> {
  return {
    from: params.from,
    to: params.to,
    direction: params.direction,
    status: params.status,
    country: params.country,
    campaign_id: params.campaignId,
    keyword: params.keyword,
    number: params.number,
  };
}
