/** Base class for every error thrown by the Texto SDK. */
export class TextoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextoError";
  }
}

/** Thrown when the API returns a non-2xx response. */
export class TextoApiError extends TextoError {
  /** HTTP status code. */
  readonly status: number;
  /** Machine readable code returned by the API, when present. */
  readonly code?: string;
  /** Full parsed response body. */
  readonly body: unknown;
  /** Value of the request id header, when present. */
  readonly requestId?: string;

  constructor(opts: { message: string; status: number; code?: string; body: unknown; requestId?: string }) {
    super(opts.message);
    this.name = "TextoApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
    this.requestId = opts.requestId;
  }
}

/** Thrown when the API key is missing, invalid or revoked (401). */
export class TextoAuthenticationError extends TextoApiError {
  constructor(opts: ConstructorParameters<typeof TextoApiError>[0]) {
    super(opts);
    this.name = "TextoAuthenticationError";
  }
}

/** Thrown when the account lacks access or the request was blocked (403). */
export class TextoPermissionError extends TextoApiError {
  constructor(opts: ConstructorParameters<typeof TextoApiError>[0]) {
    super(opts);
    this.name = "TextoPermissionError";
  }
}

/** Thrown when the request was rejected as invalid (400, 405, 409). */
export class TextoInvalidRequestError extends TextoApiError {
  constructor(opts: ConstructorParameters<typeof TextoApiError>[0]) {
    super(opts);
    this.name = "TextoInvalidRequestError";
  }
}

/** Thrown when the account has too few credits or a card problem occurred (402). */
export class TextoInsufficientCreditsError extends TextoApiError {
  readonly creditsRequired?: number;
  readonly creditsAvailable?: number;

  constructor(opts: ConstructorParameters<typeof TextoApiError>[0]) {
    super(opts);
    this.name = "TextoInsufficientCreditsError";
    const body = opts.body as Record<string, unknown> | null;
    this.creditsRequired = typeof body?.credits_required === "number" ? body.credits_required : undefined;
    this.creditsAvailable = typeof body?.credits_available === "number" ? body.credits_available : undefined;
  }
}

/** Thrown when the resource does not exist (404). */
export class TextoNotFoundError extends TextoApiError {
  constructor(opts: ConstructorParameters<typeof TextoApiError>[0]) {
    super(opts);
    this.name = "TextoNotFoundError";
  }
}

/** Thrown when the API is rate limiting the caller (429). */
export class TextoRateLimitError extends TextoApiError {
  /** Seconds to wait before retrying, if the API supplied a Retry-After header. */
  readonly retryAfter?: number;

  constructor(opts: ConstructorParameters<typeof TextoApiError>[0] & { retryAfter?: number }) {
    super(opts);
    this.name = "TextoRateLimitError";
    this.retryAfter = opts.retryAfter;
  }
}

/** Thrown for 5xx responses and degraded-service replies. */
export class TextoServerError extends TextoApiError {
  constructor(opts: ConstructorParameters<typeof TextoApiError>[0]) {
    super(opts);
    this.name = "TextoServerError";
  }
}

/** Thrown when the request could not be completed (network failure or timeout). */
export class TextoConnectionError extends TextoError {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TextoConnectionError";
    this.cause = cause;
  }
}

export function errorFromResponse(
  status: number,
  body: unknown,
  requestId?: string,
  retryAfter?: number,
): TextoApiError {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const message =
    typeof record.error === "string" ? record.error : `Texto API request failed with status ${status}`;
  const code = typeof record.code === "string" ? record.code : undefined;
  const opts = { message, status, code, body, requestId };

  switch (status) {
    case 401:
      return new TextoAuthenticationError(opts);
    case 402:
      return new TextoInsufficientCreditsError(opts);
    case 403:
      return new TextoPermissionError(opts);
    case 404:
      return new TextoNotFoundError(opts);
    case 429:
      return new TextoRateLimitError({ ...opts, retryAfter });
    default:
      if (status >= 500) return new TextoServerError(opts);
      return new TextoInvalidRequestError(opts);
  }
}
