import { ProviderError } from "./provider-error.js";
export async function limitedJson(
  response: Response,
  signal: AbortSignal,
  max = 2 * 1024 * 1024,
): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new ProviderError("EXNESS_RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new ProviderError("EXNESS_INVALID_RESPONSE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ProviderError("TIMEOUT", 504);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ProviderError("EXNESS_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new ProviderError("TIMEOUT", 504);
    const bytes = Buffer.concat(chunks);
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
