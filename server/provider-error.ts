export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 502,
    public retryAfter?: number,
    public details?: {
      rateLimitSource?:
        | "INTERNAL_USER"
        | "INTERNAL_PROVIDER_REST"
        | "INTERNAL_WS_LEASE"
        | "EXNESS_REST"
        | "EXNESS_WS";
      providerCode?: number;
      upstreamStatus?: number;
      limitCause?:
        "PROVIDER_AGE" | "PROVIDER_DATA_UNAVAILABLE" | "CURSOR_FLOOR";
    },
  ) {
    super(code);
  }
}
