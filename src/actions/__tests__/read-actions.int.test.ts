/**
 * Calls EVERY exported read action (get*) as a real logged-in user against the local dev stack and fails on:
 *   - any thrown error (missing column / relationship / bad enum value in a query), and
 *   - any error an action swallowed but logged with console.error (pages that quietly show an empty list).
 * This is what catches "the page loads but the list is always empty" bugs that type-checking cannot see.
 *   bash supabase/local/stack.sh up && bash supabase/local/stack.sh seed && npm run test:int
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, signInAs, actAs, type TestUser } from "@/test/int/session";

const MODULES = [
  "accounting", "admin", "bank", "batches", "cf", "credit-notes", "dashboard", "farmer-sales", "farmers", "fms", "gate-passes",
  "gst", "inventory", "licences", "locations", "logistics", "memo", "parties", "products", "purchase-invoices", "purchase-orders",
  "reports", "sales-invoices", "sales-orders", "stock-journals", "stock-ledger", "subsidy", "tax-profiles",
] as const;

const month = new Date().toISOString().slice(0, 7);
const period = `${month.slice(5, 7)}${month.slice(0, 4)}`;           // MMYYYY, the GST return period format
const dateRange: [string, string] = [`${month.slice(0, 4)}-01-01`, `${month.slice(0, 4)}-12-31`];

// read actions that need arguments; everything else is called with none
let ids: { supplier: string; product: string };
const args = (name: string): unknown[] | "skip" => {
  switch (name) {
    case "getBankStatements": return [{}];
    case "getJournalVouchersForMatching":
    case "getReceiptsForMatching": return [""];
    case "getGstr1Data":
    case "getGstSummaryReport": return [period];
    case "getStockLedger": return [{}];
    case "getPLReport": return [{ fromMonth: `${month.slice(0, 4)}-04`, toMonth: month }];
    case "getDayBook": return [{ fromDate: dateRange[0], toDate: dateRange[1] }];
    case "getGSTSalesRegister": return dateRange;
    case "getMatchCandidates": return [ids.supplier];
    case "getBatchesForProduct": return [ids.product];
    // need an id of a record that does not exist in a fresh database
    case "getFmsImportDetail": case "getGstr2bItems": case "getPurchaseOrderById": case "getSubsidyClaimDetail": return "skip";
    default: return [];
  }
};

beforeAll(async () => {
  await signInAs("admin"); await signInAs("accountant"); await signInAs("viewer");
  const a = adminClient();
  const sup = await a.from("parties").select("id").eq("name", "Kisan Fertilisers Ltd").single();
  const prod = await a.from("products").select("id").eq("name", "Urea 45kg").single();
  ids = { supplier: sup.data!.id, product: prod.data!.id };
});

afterAll(() => vi.restoreAllMocks());

async function runAll(user: TestUser) {
  actAs(user);
  const failures: string[] = [];
  let called = 0;
  for (const mod of MODULES) {
    const m = (await import(`@/actions/${mod}`)) as Record<string, unknown>;
    for (const [name, fn] of Object.entries(m)) {
      if (!/^get[A-Z]/.test(name) || typeof fn !== "function") continue;
      const a = args(name);
      if (a === "skip") continue;
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await (fn as (...x: unknown[]) => Promise<unknown>)(...a);
        called++;
        if (spy.mock.calls.length) failures.push(`${mod}.${name}: swallowed error -> ${spy.mock.calls.map((c) => c.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")).join(" | ").slice(0, 300)}`);
      } catch (e) {
        failures.push(`${mod}.${name}: threw -> ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
      } finally { spy.mockRestore(); }
    }
  }
  return { failures, called };
}

describe("every read action runs clean against the real database", () => {
  it("as the admin", async () => {
    const { failures, called } = await runAll("admin");
    expect(called).toBeGreaterThan(60);
    expect(failures).toEqual([]);
  });
  it("as a viewer (read-only role)", async () => {
    const { failures } = await runAll("viewer");
    expect(failures).toEqual([]);
  });
});
