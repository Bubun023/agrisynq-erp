import { describe, it, expect } from "vitest";
import { round2, splitGst, computeLine, sumLines, resolveInvoiceType } from "../gst";

describe("round2", () => {
  it("rounds half up at 2 decimals", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("splitGst", () => {
  it("interstate: all IGST", () => {
    expect(splitGst(1000, 18, true)).toEqual({
      cgst: 0, cgstRate: 0, sgst: 0, sgstRate: 0, igst: 180, igstRate: 18,
    });
  });

  it("intrastate: CGST + SGST at half rate", () => {
    const g = splitGst(1000, 18, false);
    expect(g.cgst).toBe(90);
    expect(g.sgst).toBe(90);
    expect(g.cgstRate).toBe(9);
    expect(g.igst).toBe(0);
  });

  it("intrastate: odd paise never lose money (cgst + sgst == total GST)", () => {
    // 0.05 * 5% = 0.0025 -> 0 ; 10.10 * 5% = 0.505 -> 0.51 total
    const g = splitGst(10.1, 5, false);
    expect(round2(g.cgst + g.sgst)).toBe(0.51);
    expect(g.cgst).toBe(0.26);
    expect(g.sgst).toBe(0.25);
  });

  it("zero-rated supply produces no tax", () => {
    const g = splitGst(500, 0, false);
    expect(g.cgst + g.sgst + g.igst).toBe(0);
  });
});

describe("computeLine", () => {
  it("applies discount before tax", () => {
    const l = computeLine({ qty: 10, unitPrice: 100, discountPercent: 10, gstRate: 5, isInterstate: false });
    expect(l.gross).toBe(1000);
    expect(l.discount).toBe(100);
    expect(l.taxable).toBe(900);
    expect(l.cgst).toBe(22.5);
    expect(l.sgst).toBe(22.5);
    expect(l.lineTotal).toBe(945);
  });

  it("treats a missing discount as zero", () => {
    const l = computeLine({ qty: 3, unitPrice: 33.33, gstRate: 12, isInterstate: true });
    expect(l.discount).toBe(0);
    expect(l.taxable).toBe(99.99);
    expect(l.igst).toBe(12);
    expect(l.lineTotal).toBe(111.99);
  });
});

describe("sumLines", () => {
  it("document totals equal the sum of the rounded printed lines", () => {
    const lines = Array.from({ length: 7 }, () =>
      computeLine({ qty: 1, unitPrice: 33.33, gstRate: 5, isInterstate: false })
    );
    const t = sumLines(lines);
    const printedTaxable = round2(lines.reduce((a, l) => a + l.taxable, 0));
    const printedGst = round2(lines.reduce((a, l) => a + l.cgst + l.sgst, 0));
    expect(t.taxable).toBe(printedTaxable);
    expect(round2(t.cgst + t.sgst)).toBe(printedGst);
    expect(round2(t.cgst + t.sgst + t.igst + t.taxable)).toBe(
      round2(lines.reduce((a, l) => a + l.lineTotal, 0))
    );
  });
});

describe("resolveInvoiceType", () => {
  const gstin = "27AABCU9603R1ZX";
  it("registered customer is B2B regardless of value", () => {
    expect(resolveInvoiceType(gstin, false, 10)).toBe("B2B");
    expect(resolveInvoiceType(gstin, true, 9_999_999)).toBe("B2B");
  });
  it("B2C Large only when inter-state AND above 2.5 lakh", () => {
    expect(resolveInvoiceType(null, true, 250001)).toBe("B2C_LARGE");
    expect(resolveInvoiceType(null, true, 250000)).toBe("B2C_SMALL");
    expect(resolveInvoiceType(null, false, 900000)).toBe("B2C_SMALL");
    expect(resolveInvoiceType(null, true, 1000)).toBe("B2C_SMALL");
  });
  it("malformed GSTIN is not treated as B2B", () => {
    expect(resolveInvoiceType("123", false, 100)).toBe("B2C_SMALL");
  });
});
