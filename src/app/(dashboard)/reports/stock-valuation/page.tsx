import StockValuationClient from "./StockValuationClient";

export const metadata = { title: "Stock Valuation | FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default function StockValuationPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Stock Valuation &amp; Ageing</h1>
        <p className="text-sm text-slate-500 mt-1">Stock on hand as on any date at batch cost, reconciled to Stock in Hand in the books, with ageing and expiry.</p>
      </div>
      <StockValuationClient today={new Date().toISOString().slice(0, 10)} />
    </div>
  );
}
