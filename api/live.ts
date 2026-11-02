import http from "node:http";
import { attachLive } from "../server/live-bridge.js";
export default attachLive(
  http.createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  }),
);
