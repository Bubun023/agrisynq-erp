'use server';

import { createClient } from '@/lib/supabase/server';
import { getUserContext, writeAuditLog } from '@/actions/context';
import { revalidatePath } from 'next/cache';

// ─── Types ────────────────────────────────────────────────────

export type StockLedgerRow = {
  txn_date: string;
  txn_type: string;
  txn_ref: string;
  txn_id: string;
  product_id: string;
  product_name: string;
  product_code: string;
  hsn_sac_code: string | null;
  batch_id: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  location_id: string | null;
  location_name: string | null;
  qty_in: number;
  qty_out: number;
  rate: number;
  running_balance: number;
  notes: string | null;
};

export type StockSummaryRow = {
  product_id: string;
  product_name: string;
  product_code: string;
  hsn_sac_code: string | null;
  location_id: string | null;
  location_name: string | null;
  qty_on_hand: number;
};

export type BatchRegisterRow = {
  batch_id: string;
  product_id: string;
  product_name: string;
  product_code: string;
  batch_no: string;
  manufacture_date: string | null;
  expiry_date: string | null;
  expiry_status: 'NO_EXPIRY' | 'EXPIRED' | 'EXPIRING_SOON' | 'VALID';
  purchase_rate: number | null;
  mrp: number | null;
  qty_on_hand: number;
};

export type StockAdjustment = {
  id: string;
  adjustment_no: string;
  adjustment_date: string;
  product_id: string;
  batch_id: string | null;
  location_id: string | null;
  reason: string;
  qty_before: number;
  qty_adjustment: number;
  qty_after: number;
  notes: string | null;
  created_at: string;
  products?: { product_name: string; product_code: string };
  inventory_batches?: { batch_no: string } | null;
  locations?: { location_name: string } | null;
};

// ─── Stock Ledger ─────────────────────────────────────────────

export async function getStockLedger(filters: {
  productId?: string;
  locationId?: string;
  batchId?: string;
  fromDate?: string;
  toDate?: string;
  txnType?: string;
  limit?: number;
  offset?: number;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('vw_stock_ledger')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('txn_date', { ascending: false })
    .order('txn_id', { ascending: false });

  if (filters.productId)  query = query.eq('product_id', filters.productId);
  if (filters.locationId) query = query.eq('location_id', filters.locationId);
  if (filters.batchId)    query = query.eq('batch_id', filters.batchId);
  if (filters.txnType)    query = query.eq('txn_type', filters.txnType);
  if (filters.fromDate)   query = query.gte('txn_date', filters.fromDate);
  if (filters.toDate)     query = query.lte('txn_date', filters.toDate);

  const limit  = filters.limit  ?? 100;
  const offset = filters.offset ?? 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) throw new Error(`Stock ledger error: ${error.message}`);
  return data as StockLedgerRow[];
}

// ─── Stock Summary ────────────────────────────────────────────

export async function getStockSummary(filters?: {
  productId?: string;
  locationId?: string;
  lowStockOnly?: boolean;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('vw_stock_summary')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('product_name', { ascending: true });

  if (filters?.productId)  query = query.eq('product_id', filters.productId);
  if (filters?.locationId) query = query.eq('location_id', filters.locationId);
  if (filters?.lowStockOnly) query = query.lte('qty_on_hand', 0);

  const { data, error } = await query;
  if (error) throw new Error(`Stock summary error: ${error.message}`);
  return data as StockSummaryRow[];
}

// ─── Batch Register ───────────────────────────────────────────

export async function getBatchRegister(filters?: {
  productId?: string;
  expiryStatus?: string;
  expiringWithinDays?: number;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('vw_batch_register')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('expiry_date', { ascending: true, nullsFirst: false });

  if (filters?.productId)    query = query.eq('product_id', filters.productId);
  if (filters?.expiryStatus) query = query.eq('expiry_status', filters.expiryStatus);

  const { data, error } = await query;
  if (error) throw new Error(`Batch register error: ${error.message}`);

  let rows = data as BatchRegisterRow[];

  // Client-side filter for expiring within N days
  if (filters?.expiringWithinDays) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + filters.expiringWithinDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    rows = rows.filter(r => r.expiry_date && r.expiry_date <= cutoffStr);
  }

  return rows;
}

// ─── Stock Adjustments — List ─────────────────────────────────

export async function getStockAdjustments(filters?: {
  productId?: string;
  fromDate?: string;
  toDate?: string;
  reason?: string;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('stock_adjustments')
    .select(`
      *,
      products(product_name, product_code),
      inventory_batches(batch_no),
      locations(location_name)
    `)
    .eq('organisation_id', ctx.organisationId)
    .order('adjustment_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (filters?.productId) query = query.eq('product_id', filters.productId);
  if (filters?.reason)    query = query.eq('reason', filters.reason);
  if (filters?.fromDate)  query = query.gte('adjustment_date', filters.fromDate);
  if (filters?.toDate)    query = query.lte('adjustment_date', filters.toDate);

  const { data, error } = await query.limit(200);
  if (error) throw new Error(`Adjustments list error: ${error.message}`);
  return data as StockAdjustment[];
}

// ─── Stock Adjustments — Create ───────────────────────────────

export async function createStockAdjustment(payload: {
  adjustment_date: string;
  product_id: string;
  batch_id?: string;
  location_id?: string;
  reason: string;
  qty_adjustment: number;
  notes?: string;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  // Fetch current stock for this product (+ batch if provided)
  const summaryFilters: { productId: string; locationId?: string } = {
    productId: payload.product_id,
  };
  if (payload.location_id) summaryFilters.locationId = payload.location_id;

  const summary = await getStockSummary(summaryFilters);
  const currentQty = summary.reduce((sum, r) => sum + Number(r.qty_on_hand), 0);
  const qtyAfter   = currentQty + payload.qty_adjustment;

  if (qtyAfter < 0) {
    return { error: `Adjustment would result in negative stock (${qtyAfter.toFixed(3)}). Current stock: ${currentQty.toFixed(3)}.` };
  }

  const { data, error } = await supabase
    .from('stock_adjustments')
    .insert({
      organisation_id: ctx.organisationId,
      branch_id:       ctx.branchId ?? null,
      adjustment_date: payload.adjustment_date,
      product_id:      payload.product_id,
      batch_id:        payload.batch_id ?? null,
      location_id:     payload.location_id ?? null,
      reason:          payload.reason,
      qty_before:      currentQty,
      qty_adjustment:  payload.qty_adjustment,
      qty_after:       qtyAfter,
      notes:           payload.notes ?? null,
      created_by:      ctx.userId,
    })
    .select()
    .single();

  if (error) return { error: error.message };

  await writeAuditLog({
    ctx,
    action:    'CREATE',
    tableName: 'stock_adjustments',
    recordId:  data.id,
    newValues: data,
  });

  revalidatePath('/inventory/adjustments');
  revalidatePath('/inventory/ledger');
  return { data };
}

// ─── Transfers List ───────────────────────────────────────────

export async function getStockTransfers(filters?: {
  fromDate?: string;
  toDate?: string;
  status?: string;
  productId?: string;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('stock_transfers')
    .select(`
      *,
      products(product_name, product_code),
      from_location:locations!stock_transfers_from_location_id_fkey(location_name),
      to_location:locations!stock_transfers_to_location_id_fkey(location_name),
      inventory_batches(batch_no)
    `)
    .eq('organisation_id', ctx.organisationId)
    .order('transfer_date', { ascending: false });

  if (filters?.status)    query = query.eq('status', filters.status);
  if (filters?.productId) query = query.eq('product_id', filters.productId);
  if (filters?.fromDate)  query = query.gte('transfer_date', filters.fromDate);
  if (filters?.toDate)    query = query.lte('transfer_date', filters.toDate);

  const { data, error } = await query.limit(200);
  if (error) throw new Error(`Transfers error: ${error.message}`);
  return data;
}

// ─── Lookup helpers ───────────────────────────────────────────

export async function getProductsForLookup() {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('products')
    .select('id, product_name, product_code')
    .eq('organisation_id', ctx.organisationId)
    .eq('is_active', true)
    .order('product_name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getLocationsForLookup() {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('locations')
    .select('id, location_name, location_type')
    .eq('organisation_id', ctx.organisationId)
    .order('location_name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getBatchesForProduct(productId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('inventory_batches')
    .select('id, batch_no, expiry_date')
    .eq('organisation_id', ctx.organisationId)
    .eq('product_id', productId)
    .order('batch_no');
  if (error) throw new Error(error.message);
  return data ?? [];
}
