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
      products(product_name:name, product_code),
      inventory_batches:batch_register(batch_no:batch_number),
      locations(location_name:name)
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
// Atomic: post_stock_adjustment() checks the balance, writes the stock_ledger movement
// (ADJ_INCREASE / ADJ_DECREASE / EXPIRY_ / DAMAGE_WRITE_OFF) and the adjustment document
// in one transaction, so an adjustment can never exist without moving stock (migration 032).

export async function createStockAdjustment(payload: {
  adjustment_date: string;
  product_id: string;
  batch_id?: string;
  location_id: string;
  reason: string;
  qty_adjustment: number;
  notes?: string;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!payload.location_id) return { error: 'Select the location whose stock is being adjusted.' };

  const { data, error } = await supabase.rpc('post_stock_adjustment', {
    p_organisation_id: ctx.organisationId,
    p_branch_id:       ctx.branchId ?? null,
    p_date:            payload.adjustment_date,
    p_product_id:      payload.product_id,
    p_batch_id:        payload.batch_id || null,
    p_location_id:     payload.location_id,
    p_reason:          payload.reason,
    p_qty_adjustment:  payload.qty_adjustment,
    p_notes:           payload.notes ?? null,
  });

  if (error) return { error: error.message };

  await writeAuditLog({
    ctx,
    action:    'CREATE',
    tableName: 'stock_adjustments',
    recordId:  (data as { id: string }).id,
    newValues: data as Record<string, unknown>,
  });

  revalidatePath('/inventory/adjustments');
  revalidatePath('/inventory/ledger');
  revalidatePath('/inventory/batches');
  return { data: data as StockAdjustment };
}

// ─── Lookup helpers ───────────────────────────────────────────

export async function getProductsForLookup() {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('products')
    .select('id, product_name:name, product_code')
    .eq('organisation_id', ctx.organisationId)
    .eq('is_active', true)
    .order('name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getLocationsForLookup() {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('locations')
    .select('id, location_name:name, location_type')
    .eq('organisation_id', ctx.organisationId)
    .eq('is_active', true)
    .order('name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getBatchesForProduct(productId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('batch_register')
    .select('id, batch_no:batch_number, expiry_date, current_qty')
    .eq('organisation_id', ctx.organisationId)
    .eq('product_id', productId)
    .order('expiry_date', { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
