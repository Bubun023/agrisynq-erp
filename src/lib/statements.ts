/** Pure helpers for the statement reports (balance sheet shaping, CSV export). Unit tested. */

export type AccountBalance = {
  account_id: string; account_code: string; account_name: string; account_type: string; account_group: string | null; balance: number;
};
export type BsGroup = { group: string; accounts: { code: string; name: string; amount: number }[]; total: number };
export type BalanceSheet = {
  assets: BsGroup[]; liabilities: BsGroup[]; equity: BsGroup[];
  totalAssets: number; totalLiabilities: number; totalEquity: number;
  /** cumulative income less expense up to the date (the books are not closed year by year) */
  profit: number;
  totalIncome: number; totalExpense: number;
  /** assets - (liabilities + equity + profit); must be 0 */
  difference: number;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function groupUp(rows: AccountBalance[], sign: 1 | -1): BsGroup[] {
  const map = new Map<string, BsGroup>();
  for (const a of rows) {
    const amount = r2(a.balance * sign);
    if (amount === 0) continue;                       // accounts with nothing in them are noise
    const key = a.account_group || "Other";
    let g = map.get(key);
    if (!g) { g = { group: key, accounts: [], total: 0 }; map.set(key, g); }
    g.accounts.push({ code: a.account_code, name: a.account_name, amount });
    g.total = r2(g.total + amount);
  }
  return Array.from(map.values());
}
const sum = (gs: BsGroup[]) => r2(gs.reduce((s, g) => s + g.total, 0));

/** Debit-positive balances in, presentation out: assets as they are, liabilities/equity flipped, P&L rolled into one line. */
export function buildBalanceSheet(rows: AccountBalance[]): BalanceSheet {
  const by = (t: string) => rows.filter((r) => r.account_type === t);
  const assets = groupUp(by("ASSET"), 1);
  const liabilities = groupUp(by("LIABILITY"), -1);
  const equity = groupUp(by("EQUITY"), -1);
  const totalIncome = r2(-by("INCOME").reduce((s, r) => s + r.balance, 0));
  const totalExpense = r2(by("EXPENSE").reduce((s, r) => s + r.balance, 0));
  const profit = r2(totalIncome - totalExpense);
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities), totalEquity = sum(equity);
  return { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, profit, totalIncome, totalExpense,
           difference: r2(totalAssets - (totalLiabilities + totalEquity + profit)) };
}

/** RFC-4180 CSV text (with BOM so Excel reads rupee symbols / unicode correctly). */
export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(","))].join("\r\n") + "\r\n";
}

export function fyStartOf(d: Date = new Date()): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}
