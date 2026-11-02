import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import type { Database } from "./database.js";
import { ProviderError } from "./provider-error.js";
type LiveIdentity = { user: { id: string }; session: { id: string } };
async function session(headers: IncomingHttpHeaders) {
  try {
    return await auth().api.getSession({ headers: fromNodeHeaders(headers) });
  } catch {
    throw new ProviderError("AUTH_UNAVAILABLE", 503);
  }
}
export async function requireLiveSession(headers: IncomingHttpHeaders) {
  const identity = await session(headers);
  if (!identity) throw new ProviderError("SESSION_MISSING", 401);
  return identity;
}
// No session, ownership or selection result is cached across calls/instances.
// Session IDs are compared only in memory and are never diagnostic fields.
export async function revalidateLiveAccess(
  headers: IncomingHttpHeaders,
  initial: LiveIdentity,
  db: Database,
  connectionId: string,
) {
  const current = await session(headers);
  if (!current) throw new ProviderError("SESSION_REVOKED", 401);
  if (
    current.user.id !== initial.user.id ||
    current.session.id !== initial.session.id
  )
    throw new ProviderError("SESSION_CHANGED", 401);
  let selected;
  try {
    selected = await db.query(
      "SELECT c.id FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND c.status='verified'",
      [connectionId, initial.user.id],
    );
  } catch {
    throw new ProviderError("ACCOUNT_SERVICE_UNAVAILABLE", 503);
  }
  if (!selected.rows.length)
    throw new ProviderError("SELECTED_CONNECTION_UNAVAILABLE", 409);
}
