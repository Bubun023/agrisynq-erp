import { describe, it, expect } from "vitest";
import { calcMemoLine, isMemoError, journalOutValue, journalInUnitCost, round4 } from "../memo";

function ok(r: ReturnType<typeof calcMemoLine>) {
  if (isMemoError(r)) throw new Error(r.error);
  return r;
}

describe("calcMemoLine", () => {
  it("cost is the purchase rate minus the percentage discount - no GST", () => {
    const r = ok(calcMemoLine({ qty: 100, rate: 10, discountPercent: 2 }));
    expect(r.gross).toBe(1000);
    expect(r.net).toBe(980);
    expect(r.unitCost).toBe(9.8);
  });

  it("applies the flat discount after the percentage and spreads over free units", () => {
    const r = ok(calcMemoLine({ qty: 10, freeQty: 5, rate: 10, discountAmount: 5 }));
    expect(r.net).toBe(95);
    expect(r.totalUnits).toBe(15);
    expect(r.unitCost).toBe(6.3333);
  });

  it("combines percentage then flat", () => {
    // 50 x 20 = 1000; -10% = 900; -50 flat = 850
    expect(ok(calcMemoLine({ qty: 50, rate: 20, discountPercent: 10, discountAmount: 50 })).net).toBe(850);
  });

  it("free goods can be costed at zero", () => {
    const r = ok(calcMemoLine({ qty: 10, rate: 10, discountPercent: 100 }));
    expect(r.net).toBe(0);
    expect(r.unitCost).toBe(0);
  });

  it("rejects what the database would reject", () => {
    expect(calcMemoLine({ qty: 0, rate: 10 })).toEqual({ error: "Quantity must be greater than 0" });
    expect(calcMemoLine({ qty: 1, rate: -1 })).toEqual({ error: "Rate cannot be negative" });
    expect(calcMemoLine({ qty: 1, rate: 10, discountPercent: 101 })).toEqual({ error: "Discount % must be between 0 and 100" });
    expect(calcMemoLine({ qty: 1, rate: 10, freeQty: -1 })).toEqual({ error: "Free quantity cannot be negative" });
    expect(calcMemoLine({ qty: 1, rate: 10, discountAmount: 11 })).toEqual({ error: "The discount is larger than the value of the goods" });
  });
});

describe("stock journal value", () => {
  it("carries the outgoing value onto the incoming quantity", () => {
    const out = journalOutValue([{ qty: 100, unitCost: 10 }]);
    expect(out).toBe(1000);
    expect(journalInUnitCost(out, 100)).toBe(10);
  });

  it("works when the quantities differ (value is preserved, cost per unit changes)", () => {
    const out = journalOutValue([{ qty: 50, unitCost: 9.8 }, { qty: 10, unitCost: 6.3333 }]);
    expect(out).toBe(553.33);
    expect(journalInUnitCost(out, 45)).toBe(round4(553.33 / 45));
  });

  it("never divides by zero", () => {
    expect(journalInUnitCost(100, 0)).toBe(0);
  });
});
