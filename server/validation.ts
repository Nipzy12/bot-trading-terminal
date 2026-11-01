import { z } from "zod";
export const candleSchema = z
  .object({
    time: z.number().int().positive(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
  })
  .refine(
    (c) =>
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close) &&
      c.low <= c.high,
  );
