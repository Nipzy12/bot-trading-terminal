// Vercel invokes Express as a request handler. Never import server/index.ts here:
// that entrypoint opens a TCP listener and is reserved for local development.
import { app } from "../server/app.js";

export default app;
