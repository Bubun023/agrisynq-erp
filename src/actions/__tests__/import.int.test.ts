/** Go-live import through the REAL server actions: CSV text -> parse -> master data -> opening stock & balances. */
import { beforeAll, describe, expect, it } from "vitest";
import { signInAs, actAs } from "@/test/int/session";
import { admin, tag, today, tenantId, stockOf, glBalance } from "@/test/int/helpers";
import { getEntity, parseImportFile } from "@/lib/data-import";
import { importMasterData, importOpeningBalances } from "@/actions/data-import";

const gstin = `27ABCDE${String(Date.now()).slice(-4)}F1Z5`;
const parse = (entity: string, csv: string) => parseImportFile(csv, getEntity(entity)!);
let tid: string;

beforeAll(async () => {
  for (const u of ["admin", "accountant", "viewer", "sales"] as const) await signInAs(u);
  actAs("admin");
  tid = await tenantId();
});

describe("master data import", () => {
  it("imports good rows, reports bad ones with their file line, and refuses duplicates on re-upload", async () => {
    const csv = [
      "name,code,location_type,ownership",
      `Imp Godown ${tag},IG${tag},own,OWN`,
      `Imp Shop ${tag},IS${tag},BRANCH_WAREHOUSE,`,
      `Broken ${tag},,MOON_BASE,OWN`,
    ].join("\n");
    const p = parse("locations", csv);
    expect(p.issues.map((i) => i.row)).toEqual([4]);                    // the enum problem is caught before the server
    const r = await importMasterData("locations", p.rows);
    expect(r.imported).toBe(2);
    expect(r.results.find((x) => x.row === 4)?.ok).toBe(false);
    const again = await importMasterData("locations", p.rows.slice(0, 2));
    expect(again.imported).toBe(0);                                      // duplicates are refused, not doubled
    const n = await admin.from("locations").select("id", { count: "exact", head: true }).eq("tenant_id", tid).eq("name", `Imp Godown ${tag}`);
    expect(n.count).toBe(1);
  });

  it("imports parties, products and farmers with Indian-style numbers and yes/no flags", async () => {
    const parties = parse("parties", [
      "name,code,party_type,gstin,gst_status,credit_limit,credit_days",
      `Imp Customer ${tag},IC${tag},customer,,UNREGISTERED,"1,50,000",30`,
      `Imp Supplier ${tag},ISU${tag},supplier,${gstin},regular,0,0`,
      `Bad GST ${tag},,CUSTOMER,NOT-A-GSTIN,REGULAR,0,0`,
    ].join("\n"));
    const pr = await importMasterData("parties", parties.rows);
    expect(pr.imported).toBe(2);
    expect(pr.results.find((x) => !x.ok)?.message).toMatch(/gstin/i);
    const cust = (await admin.from("parties").select("is_customer, is_supplier, credit_limit").eq("tenant_id", tid).eq("name", `Imp Customer ${tag}`).single()).data!;
    expect(cust).toMatchObject({ is_customer: true, is_supplier: false, credit_limit: 150000 });
    const supp = (await admin.from("parties").select("is_customer, is_supplier").eq("tenant_id", tid).eq("name", `Imp Supplier ${tag}`).single()).data!;
    expect(supp).toMatchObject({ is_customer: false, is_supplier: true });

    const products = parse("products", [
      "name,product_code,category,hsn_code,unit_of_measure,gst_rate,batch_required,mrp",
      `Imp Urea ${tag},IU${tag},fertilizer,3102,BAG,5,yes,"266.50"`,
      `Imp DAP ${tag},ID${tag},FERTILIZER,3105,BAG,5,yes,1350`,
    ].join("\n"));
    expect((await importMasterData("products", products.rows)).imported).toBe(2);

    const farmers = parse("farmers", ["first_name,last_name,phone,village,aadhaar_last4", `Imp${tag},Farmer,98${String(Date.now()).slice(-8)},Wadgaon,4321`, `NoPhone${tag},Farmer,12345,Wadgaon,4321`].join("\n"));
    const fr = await importMasterData("farmers", farmers.rows);
    expect(fr.imported).toBe(1);
    expect(fr.results.find((x) => !x.ok)?.message).toMatch(/mobile/i);
  });

  it("a viewer cannot import", async () => {
    actAs("viewer");
    const r = await importMasterData("locations", parse("locations", `name,location_type\nViewer ${tag},OWN\n`).rows);
    expect(r.imported).toBe(0);
    actAs("admin");
    expect((await admin.from("locations").select("id").eq("tenant_id", tid).eq("name", `Viewer ${tag}`)).data).toHaveLength(0);
  });
});

describe("opening stock and balances", () => {
  beforeAll(async () => {
    const org = (await admin.from("organisations").select("id").eq("tenant_id", tid).limit(1).single()).data!.id;
    const { error } = await admin.from("chart_of_accounts").insert({ tenant_id: tid, organisation_id: org, account_code: `OB${tag}`, account_name: `Opening test bank ${tag}`, account_type: "ASSET", account_group: "Current Assets" });
    if (error) throw new Error(error.message);
  });
  const stockCsv = () => [
    "product,location,batch_number,qty,cost_rate,expiry_date",
    `IU${tag},IG${tag},OB-${tag}-1,100,240,31/01/2027`,
    `Imp DAP ${tag},Imp Godown ${tag},OB-${tag}-2,50,"1,200",`,
  ].join("\n");
  const partyCsv = () => ["party,amount,side", `IC${tag},45000,`, `Imp Supplier ${tag},30000,SUPPLIER`].join("\n");
  const acct = `OB${tag}`;   // a ledger account can be opened only once, so every run uses a fresh one
  const acctCsv = () => ["account_code,debit,credit", `${acct},10000,`].join("\n");

  it("a check run finds every problem and posts nothing", async () => {
    const r = await importOpeningBalances({ asOf: today, dryRun: true,
      stock: parse("opening_stock", `product,location,batch_number,qty,cost_rate\nNOPE-${tag},IG${tag},B1,5,10\nIU${tag},Nowhere,B2,0,10\nIU${tag},IG${tag},B3,5,10\nIU${tag},IG${tag},B3,5,10\n`).rows,
      parties: parse("opening_parties", `party,amount\nGhost ${tag},100\nIC${tag},0\n`).rows,
      accounts: parse("opening_accounts", "account_code,debit,credit\n1001,5,5\n").rows });
    expect(r.posted).toBe(false);
    const msgs = r.issues.map((i) => i.message).join("|");
    expect(msgs).toMatch(/Product "NOPE/);
    expect(msgs).toMatch(/Location "Nowhere"/);
    expect(msgs).toMatch(/quantity|qty must be greater/);
    expect(msgs).toMatch(/appears twice/);
    expect(msgs).toMatch(/Party "Ghost/);
    expect(msgs).toMatch(/either a debit or a credit/);
    expect((await admin.from("batch_register").select("id").eq("tenant_id", tid).like("batch_number", `OB-${tag}%`)).data).toHaveLength(0);
  });

  it("posts stock, party balances and ledger balances as one balanced journal", async () => {
    const stockBefore = await glBalance("1020");
    const debtorsBefore = await glBalance("1010");
    const creditorsBefore = await glBalance("2001");
    const bankBefore = await glBalance(acct);
    const capitalBefore = await glBalance("2100");

    const input = { asOf: today, stock: parse("opening_stock", stockCsv()).rows, parties: parse("opening_parties", partyCsv()).rows, accounts: parse("opening_accounts", acctCsv()).rows };
    const check = await importOpeningBalances({ ...input, dryRun: true });
    expect(check.issues).toEqual([]);
    expect(check.summary).toMatchObject({ stockRows: 2, stockValue: 84000, partyRows: 2, accountRows: 1 });

    // a viewer / sales manager is refused by the database
    actAs("viewer");
    expect((await importOpeningBalances({ ...input, dryRun: false })).error ?? "").toMatch(/Only an admin or accountant|permission/i);
    actAs("sales");
    expect((await importOpeningBalances({ ...input, dryRun: false })).error ?? "").toMatch(/Only an admin or accountant/i);
    actAs("accountant");
    const r = await importOpeningBalances({ ...input, dryRun: false });
    expect(r.error).toBeUndefined();
    expect(r.posted).toBe(true);

    expect(Math.round((await glBalance("1020") - stockBefore) * 100) / 100).toBe(84000);
    expect(Math.round((await glBalance("1010") - debtorsBefore) * 100) / 100).toBe(45000);
    expect(Math.round((creditorsBefore - await glBalance("2001")) * 100) / 100).toBe(30000);
    expect(Math.round((await glBalance(acct) - bankBefore) * 100) / 100).toBe(10000);
    // 84000 + 45000 + 10000 - 30000 = 109000 credited to capital
    expect(Math.round((capitalBefore - await glBalance("2100")) * 100) / 100).toBe(109000);
    expect(r.summary?.capitalBalancing).toBe(109000);
    expect(await stockOf({ batchId: (await admin.from("batch_register").select("id").eq("batch_number", `OB-${tag}-1`).single()).data!.id })).toBe(100);

    const tb = await admin.from("vw_trial_balance").select("period_debit, period_credit").eq("tenant_id", tid);
    const net = (tb.data ?? []).reduce((a, x) => a + Number(x.period_debit) - Number(x.period_credit), 0);
    expect(Math.round(net * 100)).toBe(0);

    // the same file cannot be posted twice
    const again = await importOpeningBalances({ ...input, dryRun: false });
    expect(again.posted).toBe(false);
    expect(again.error ?? "").toMatch(/already/);
    actAs("admin");
  });
});
