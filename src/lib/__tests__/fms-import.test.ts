import { describe, it, expect } from "vitest";
import { parseCsv, detectDelimiter } from "../csv";
import { mapColumns, parseNumber, parseDate, buildLines } from "../fms-import";

describe("parseCsv", () => {
  it("parses a simple file with CRLF endings and a BOM", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n3,4\r\n")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });
  it("handles quoted fields with commas, newlines and doubled quotes", () => {
    const rows = parseCsv('name,note\n"Kumar, Ram","said ""hi""\nthere"\n');
    expect(rows).toEqual([["name", "note"], ["Kumar, Ram", 'said "hi"\nthere']]);
  });
  it("drops blank rows but keeps empty cells", () => {
    expect(parseCsv("a,b,c\n\n1,,3\n,,\n")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });
  it("auto-detects semicolon and tab delimiters", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('"a,b",c')).toBe(",");
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("keeps the last row when the file has no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("mapColumns", () => {
  it("finds columns regardless of case, spaces and punctuation", () => {
    const { map, missing } = mapColumns(["S.No", "PoS Transaction ID", "Transaction Date", "Farmer Name", "Quantity (Bags)", "Subsidy Amount", "Ack. No"]);
    expect(map.pos_id).toBe(1);
    expect(map.date).toBe(2);
    expect(map.farmer).toBe(3);
    expect(map.subsidy).toBe(5);
    expect(map.ack).toBe(6);
    // "Quantity (Bags)" normalises to "quantitybags" which is not a known alias -> reported, not guessed
    expect(missing).toEqual(["qty"]);
  });
  it("reports every missing required column", () => {
    expect(mapColumns(["foo", "bar"]).missing).toEqual(["pos_id", "qty", "subsidy"]);
  });
  it("maps a clean export fully", () => {
    const { missing } = mapColumns(["Txn ID", "Qty", "Subsidy"]);
    expect(missing).toEqual([]);
  });
});

describe("parseNumber", () => {
  it("handles thousands separators and currency marks", () => {
    expect(parseNumber("1,234.50")).toBe(1234.5);
    expect(parseNumber("₹ 12,000")).toBe(12000);
    expect(parseNumber("Rs. 15")).toBe(15);
    expect(parseNumber("0")).toBe(0);
  });
  it("never guesses", () => {
    expect(parseNumber("")).toBeNaN();
    expect(parseNumber("12abc")).toBeNaN();
    expect(parseNumber("1.2.3")).toBeNaN();
  });
});

describe("parseDate", () => {
  it("accepts the common portal formats", () => {
    expect(parseDate("2026-11-07")).toBe("2026-11-07");
    expect(parseDate("07/11/2026")).toBe("2026-11-07");
    expect(parseDate("7-11-2026")).toBe("2026-11-07");
    expect(parseDate("07.11.2026")).toBe("2026-11-07");
    expect(parseDate("07-Nov-2026")).toBe("2026-11-07");
    expect(parseDate("2026-11-07T10:30:00")).toBe("2026-11-07");
  });
  it("rejects impossible or unknown dates", () => {
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("13/13/2026")).toBeNull();
    expect(parseDate("yesterday")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});

describe("buildLines", () => {
  const rows = [
    ["PoS Transaction ID", "Date", "Quantity", "Subsidy Amount", "Farmer Name"],
    ["P1", "07/11/2026", "10", "1,500.00", "Ram Kumar"],
    ["", "08/11/2026", "2", "30", "No Id"],
    ["P3", "09/11/2026", "abc", "10", "Bad Qty"],
    ["P4", "32/11/2026", "1", "10", "Bad Date"],
    ["P5", "", "1", "-5", "Negative"],
  ];
  const cm = mapColumns(rows[0]);

  it("builds good lines and reports bad ones with their file row number", () => {
    const { lines, errors } = buildLines(rows, cm);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ pos_id: "P1", date: "2026-11-07", qty: 10, subsidy: 1500, farmer: "Ram Kumar" });
    expect(lines[1].pos_id).toBe("");               // missing id is kept; the database flags it INVALID
    expect(errors.map((e) => e.row)).toEqual([4, 5, 6]);
    expect(errors[0].message).toContain("Quantity");
    expect(errors[1].message).toContain("Date");
    expect(errors[2].message).toContain("Negative");
  });
});
