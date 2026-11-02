import { z } from "zod";
export const brokerDecimal = z
  .string()
  .max(50)
  .regex(/^-?(0|[1-9]\d{0,29})(\.\d{1,18})?$/);
export function decimalUnits(value: string) {
  const v = brokerDecimal.parse(value),
    negative = v.startsWith("-"),
    [whole, fraction = ""] = (negative ? v.slice(1) : v).split(".");
  return BigInt(whole + fraction.padEnd(18, "0")) * (negative ? -1n : 1n);
}
export const brokerState = z.object({
  balance: brokerDecimal,
  equity: brokerDecimal,
  used_margin: brokerDecimal.refine((v) => decimalUnits(v) >= 0n),
});
export const brokerSnapshot = brokerState
  .extend({
    currency: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,11}$/),
    asOf: z.iso.datetime({ offset: true }),
    status: z.literal("SNAPSHOT"),
  })
  .strict();
export type BrokerSnapshot = z.infer<typeof brokerSnapshot>;
export function formatBrokerDecimal(value: string) {
  const s = brokerDecimal.parse(value),
    [whole, fraction] = s.split(".");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction === undefined ? "" : "." + fraction)
  );
}
