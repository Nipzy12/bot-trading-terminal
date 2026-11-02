export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 502,
    public retryAfter?: number,
    public details?: {
      providerCode?: number;
      upstreamStatus?: number;
      limitCause?:
        "PROVIDER_AGE" | "PROVIDER_DATA_UNAVAILABLE" | "CURSOR_FLOOR";
    },
  ) {
    super(code);
  }
}
