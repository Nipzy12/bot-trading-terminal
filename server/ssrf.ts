import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch as safeFetch } from "undici";
import { bounded } from "./connection-test.js";
import { ProviderError } from "./provider-error.js";
import { baseUrl } from "./exness.js";
export function allowedHost(host: string) {
  const suffixes = (
    process.env.EXNESS_ALLOWED_HOSTS ?? "exness.com,exness-api.com"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return suffixes.some((s) => host === s || host.endsWith("." + s));
}
export function safeOrigin(value: string) {
  const origin = baseUrl(value);
  if (!allowedHost(new URL(origin).hostname))
    throw new ProviderError("EXNESS_SSRF");
  return origin;
}
export function publicAddress(value: string) {
  try {
    let address = ipaddr.parse(value);
    if (
      address.kind() === "ipv6" &&
      (address as ipaddr.IPv6).isIPv4MappedAddress()
    )
      address = (address as ipaddr.IPv6).toIPv4Address();
    return address.range() === "unicast";
  } catch {
    return false;
  }
}
export async function resolveHost(host: string, resolver = lookup) {
  const addresses = await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new ProviderError("EXNESS_SSRF");
  return addresses;
}
// Every request revalidates the hostname and pins the validated DNS results into TLS lookup.
// Redirects are forbidden; TLS SNI/certificate verification still use the original host.
export const secureTransport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.username || url.password) throw new ProviderError("EXNESS_SSRF");
  safeOrigin(url.origin);
  init?.signal?.throwIfAborted();
  const addresses = init?.signal
    ? await bounded(() => resolveHost(url.hostname), init.signal)
    : await resolveHost(url.hostname);
  init?.signal?.throwIfAborted();
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if ((options as { all?: boolean }).all)
          callback(null, addresses as any);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    },
  });
  try {
    const response = await safeFetch(url, {
      ...init,
      dispatcher,
      redirect: "error",
    } as any);
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024)
          throw new ProviderError("EXNESS_INVALID_RESPONSE");
        chunks.push(chunk);
      }
    }
    const body = Buffer.concat(chunks);
    return new Response(body, {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  } finally {
    await dispatcher.destroy();
  }
};
