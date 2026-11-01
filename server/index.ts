import { app } from "./app";
app.listen(Number(process.env.PORT) || 3001, "127.0.0.1", () =>
  console.log("Market backend listening on localhost; live trading disabled"),
);
