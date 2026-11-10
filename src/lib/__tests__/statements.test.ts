import { describe, expect, it } from "vitest";
import { buildBalanceSheet, fyStartOf, toCsv, type AccountBalance } from "../statements";

const a = (account_code: string, account_type: string, balance: number, account_group = "g"): AccountBalance =>
  ({ account_id: account_code, account_code, account_name: `Acct ${account_code}`, account_type, account_group, balance });

describe("buildBalanceSheet", () => {
  const rows = [
    a("1001", "ASSET", 25000, "Current Assets"), a("1020", "ASSET", 84000, "Current Assets"), a("1010", "ASSET", 43000, "Current Assets"),
    a("2001", "LIABILITY", -30000, "Current Liabilities"), a("2100", "EQUITY", -150000, "Equity"),
    a("3001", "INCOME", -20000), a("4001", "EXPENSE", 8000), a("1100", "ASSET", 0, "Fixed Assets"),
  ];
  const s = buildBalanceSheet(rows);
  it("flips credit-side balances to positive and totals each side", () => {
    expect(s.totalAssets).toBe(152000);
    expect(s.totalLiabilities).toBe(30000);
    expect(s.totalEquity).toBe(150000);
  });
  it("rolls income and expenses into one profit figure", () => {
    expect(s.totalIncome).toBe(20000);
    expect(s.totalExpense).toBe(8000);
    expect(s.profit).toBe(12000);
  });
  it("balances when the books balance (and shows a difference when they do not)", () => {
    // 152000 assets = 30000 + 150000 + 12000 - 40000? no: build a consistent set
    const ok = buildBalanceSheet([a("1001", "ASSET", 100), a("2001", "LIABILITY", -30), a("2100", "EQUITY", -50), a("3001", "INCOME", -30), a("4001", "EXPENSE", 10)]);
    expect(ok.difference).toBe(0);
    expect(s.difference).not.toBe(0);                 // the sample above is deliberately unbalanced
  });
  it("leaves out accounts with nothing in them and groups the rest", () => {
    expect(s.assets.map((g) => g.group)).toEqual(["Current Assets"]);
    expect(s.assets[0].accounts).toHaveLength(3);
  });
  it("keeps cents exact", () => {
    const x = buildBalanceSheet([a("1001", "ASSET", 0.1), a("1002", "ASSET", 0.2), a("2100", "EQUITY", -0.3)]);
    expect(x.totalAssets).toBe(0.3);
    expect(x.difference).toBe(0);
  });
});

describe("toCsv", () => {
  it("quotes commas, quotes and newlines and starts with a BOM", () => {
    const out = toCsv([{ key: "n", label: "Name" }, { key: "v", label: "Value" }], [{ n: 'A, "B"', v: 1 }, { n: "line\nbreak", v: null }]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain('"A, ""B""",1');
    expect(out).toContain('"line\nbreak",');
  });
});

describe("fyStartOf", () => {
  it("is 1 April of the financial year", () => {
    expect(fyStartOf(new Date(2026, 10, 10))).toBe("2026-04-01");
    expect(fyStartOf(new Date(2027, 1, 5))).toBe("2026-04-01");
    expect(fyStartOf(new Date(2027, 3, 1))).toBe("2027-04-01");
  });
});
