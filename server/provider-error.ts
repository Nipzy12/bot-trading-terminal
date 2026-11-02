export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 502,
    public retryAfter?: number,
  ) {
    super(code);
  }
}
