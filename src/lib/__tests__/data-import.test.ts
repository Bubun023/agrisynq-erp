import { describe, expect, it } from "vitest";
import { checkOpeningRow, getEntity, IMPORT_ENTITIES, normaliseHeader, parseDate, parseImportFile, parseNumber, templateCsv } from "../data-import";

const parties = getEntity("parties")!;
const stock = getEntity("opening_stock")!;

describe("templates", () => {
  it("every template parses back cleanly with its own example row", () => {
    for (const e of IMPORT_ENTITIES) {
      const parsed = parseImportFile(templateCsv(e), e);
      expect(parsed.issues, e.key).toEqual([]);
      expect(parsed.unknownColumns, e.key).toEqual([]);
      expect(parsed.rows, e.key).toHaveLength(1);
    }
  });
});

describe("headers", () => {
  it("are matched loosely: case, spaces, hyphens, asterisks, BOM", () => {
    expect(normaliseHeader("﻿ Party Type *")).toBe("party_type");
    expect(normaliseHeader("Credit-Days")).toBe("credit_days");
  });
  it("reports missing required columns and ignores unknown ones", () => {
    const p = parseImportFile("name,colour\nA,red\n", parties);
    expect(p.missingColumns).toEqual(["party_type"]);
    expect(p.unknownColumns).toEqual(["colour"]);
    expect(p.rows).toHaveLength(0);
  });
});

describe("row cleanup", () => {
  it("normalises yes/no, numbers, enums and flags bad values with their file line", () => {
    const csv = "name,party_type,is_customer,credit_limit,gst_status\nAcme,customer,YES,\"1,50,000\",regular\nBad,SOMEONE,maybe,abc,nope\n";
    const p = parseImportFile(csv, parties);
    expect(p.rows[0]).toMatchObject({ party_type: "CUSTOMER", is_customer: "true", credit_limit: "150000", gst_status: "REGULAR" });
    const bad = p.issues.filter((i) => i.row === 3).map((i) => i.message).join("|");
    expect(bad).toContain("party_type");
    expect(bad).toContain("is_customer");
    expect(bad).toContain("credit_limit");
    expect(p.issues.some((i) => i.row === 2)).toBe(false);
  });
  it("rejects a required value left blank", () => {
    const p = parseImportFile("name,party_type\n,CUSTOMER\n", parties);
    expect(p.issues).toEqual([{ row: 2, message: "name is required" }]);
  });
  it("refuses an oversized file", () => {
    const body = Array.from({ length: 2001 }, (_, i) => `P${i},CUSTOMER`).join("\n");
    expect(parseImportFile(`name,party_type\n${body}`, parties).issues[0].message).toMatch(/Too many rows/);
  });
});

describe("numbers and dates", () => {
  it("parses Indian-style amounts", () => {
    expect(parseNumber("₹ 1,25,000.50")).toBe(125000.5);
    expect(parseNumber("-40")).toBe(-40);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("12x")).toBeNaN();
  });
  it("accepts ISO and day-first dates and rejects impossible ones", () => {
    expect(parseDate("2026-04-01")).toBe("2026-04-01");
    expect(parseDate("1/4/2026")).toBe("2026-04-01");
    expect(parseDate("31-12-2025")).toBe("2025-12-31");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("April 1")).toBeNull();
  });
});

describe("opening rows", () => {
  it("stock needs a positive quantity and sane dates", () => {
    const row = { qty: "0", cost_rate: "10", manufacture_date: "2026-05-01", expiry_date: "2026-01-01" };
    expect(checkOpeningRow("opening_stock", row)).toHaveLength(2);
    expect(parseImportFile("product,location,batch_number,qty,cost_rate\nU,G,B1,5,10\n", stock).issues).toEqual([]);
  });
  it("ledger rows need exactly one of debit / credit", () => {
    expect(checkOpeningRow("opening_accounts", { debit: "10", credit: "10" })).toHaveLength(1);
    expect(checkOpeningRow("opening_accounts", { debit: "", credit: "" })).toHaveLength(1);
    expect(checkOpeningRow("opening_accounts", { debit: "10", credit: "" })).toEqual([]);
  });
  it("a party balance cannot be zero", () => {
    expect(checkOpeningRow("opening_parties", { amount: "0" })).toHaveLength(1);
  });
});
