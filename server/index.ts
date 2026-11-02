import { createServer } from "node:http";
import { attachLive } from "./live-bridge.js";
import { app } from "./app.js";
attachLive(createServer(app)).listen(
  Number(process.env.PORT) || 3001,
  "127.0.0.1",
  () =>
    console.log("Market backend listening on localhost; live trading disabled"),
);
