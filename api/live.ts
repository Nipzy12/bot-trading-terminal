import http from "node:http";
import { livePreflight } from "../server/live-preflight.js";
import { attachLive } from "../server/live-bridge.js";
export default attachLive(
  http.createServer((req, res) => {
    if (req.url?.startsWith("/api/live/preflight")) {
      void livePreflight(req, res);
      return;
    }
    res.writeHead(426);
    res.end();
  }),
);
