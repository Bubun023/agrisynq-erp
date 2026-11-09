'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getUserContext, writeAuditLog } from '@/actions/context';

// ============================================================================
// 1. ZOD VALIDATION SCHEMAS (Server-Side Validation)
// ============================================================================

const transporterSchema = z.object({
  transporter_code: z.string().min(2, 'Code is required').max(30),
  legal_name: z.string().min(2, 'Legal name is required').max(200),
  trade_name: z.string().optional().nullable(),
  gstin: z
    .string()
    .regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'Invalid 15-character GSTIN / TRANSIN')
    .optional()
    .or(z.literal('')),
  pan: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Invalid PAN format')
    .optional()
    .or(z.literal('')),
  contact_person: z.string().optional().nullable(),
  mobile: z.string().min(10, 'Valid contact number required').max(15).optional().or(z.literal('')),
  address: z.string().optional().nullable(),
  state_code: z.string().max(5).optional().nullable(),
});

const stockTransferItemSchema = z.object({
  product_id: z.string().uuid('Select a valid product'),
  source_batch_id: z.string().uuid('Select a valid batch'),
  unit_of_measure: z.string().min(1, 'UoM is required'),
  requested_qty: z.coerce.number().positive('Quantity must be greater than 0'),
  unit_cost: z.coerce.number().min(0, 'Unit cost cannot be negative'),
  remarks: z.string().optional().nullable(),
});

const createStockTransferSchema = z
  .object({
    transfer_no: z.string().min(3, 'Transfer number is required'),
    transfer_date: z.string().min(1, 'Transfer date is required'),
    transfer_type: z.enum([
      'INTER_BRANCH',
      'CNF_TO_OWN_WAREHOUSE',
      'CNF_DIRECT_TO_CUSTOMER',
      'QUARANTINE_TRANSFER',
      'DAMAGE_TRANSFER',
    ]),
    source_location_id: z.string().uuid('Source location is required'),
    destination_location_id: z.string().uuid('Destination location is required'),
    cf_agent_id: z.string().uuid().optional().nullable().or(z.literal('')),
    cnf_withdrawal_req_no: z.string().optional().nullable(),
    cnf_company_approval_ref: z.string().optional().nullable(),
    cnf_delivery_order_no: z.string().optional().nullable(),
    transporter_id: z.string().uuid().optional().nullable().or(z.literal('')),
    vehicle_no: z.string().optional().nullable(),
    driver_name: z.string().optional().nullable(),
    driver_mobile: z.string().optional().nullable(),
    lr_rr_no: z.string().optional().nullable(),
    eway_bill_no: z.string().optional().nullable(),
    remarks: z.string().optional().nullable(),
    items: z.array(stockTransferItemSchema).min(1, 'At least one batch item is required'),
  })
  .refine((data) => data.source_location_id !== data.destination_location_id, {
    message: 'Source and destination locations must be different',
    path: ['destination_location_id'],
  });

const deliveryChallanItemSchema = z.object({
  product_id: z.string().uuid(),
  batch_id: z.string().uuid(),
  unit_of_measure: z.string().min(1),
  qty: z.coerce.number().positive(),
  declared_unit_rate: z.coerce.number().min(0),
  remarks: z.string().optional().nullable(),
});

const createDeliveryChallanSchema = z.object({
  challan_no: z.string().min(3, 'Challan number is required'),
  challan_date: z.string().min(1, 'Challan date is required'),
  purpose: z.enum([
    'BILL_TO_SHIP_TO',
    'CNF_DIRECT_DISPATCH',
    'STOCK_TRANSFER',
    'SALES_ON_APPROVAL',
    'EXHIBITION_OR_DEMO',
    'OTHER_LAWFUL_MOVEMENT',
  ]),
  dispatch_location_id: z.string().uuid('Dispatch location is required'),
  bill_to_party_id: z.string().uuid().optional().nullable().or(z.literal('')),
  ship_to_party_id: z.string().uuid().optional().nullable().or(z.literal('')),
  consignee_name: z.string().min(2, 'Consignee name is required'),
  consignee_gstin: z.string().optional().nullable(),
  delivery_address: z.string().min(5, 'Delivery address is required'),
  place_of_supply_state: z.string().min(2, 'Place of supply state is required'),
  transporter_id: z.string().uuid().optional().nullable().or(z.literal('')),
  vehicle_no: z.string().optional().nullable(),
  driver_name: z.string().optional().nullable(),
  driver_mobile: z.string().optional().nullable(),
  distance_km: z.coerce.number().min(0).optional().nullable(),
  eway_bill_no: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  items: z.array(deliveryChallanItemSchema).min(1, 'At least one item is required'),
});

export type CreateTransporterInput = z.infer<typeof transporterSchema>;
export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;
export type CreateDeliveryChallanInput = z.infer<typeof createDeliveryChallanSchema>;

// ============================================================================
// 2. SERVER ACTIONS
// ============================================================================

export async function getTransporters() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('transporters')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .order('legal_name', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createTransporter(input: CreateTransporterInput) {
  const parsed = transporterSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('transporters')
    .insert({
      tenant_id: ctx.tenantId,
      organisation_id: ctx.organisationId,
      branch_id: ctx.branchId,
      transporter_code: parsed.data.transporter_code.trim().toUpperCase(),
      legal_name: parsed.data.legal_name.trim(),
      trade_name: parsed.data.trade_name || null,
      gstin: parsed.data.gstin || null,
      pan: parsed.data.pan || null,
      contact_person: parsed.data.contact_person || null,
      mobile: parsed.data.mobile || null,
      address: parsed.data.address || null,
      state_code: parsed.data.state_code || null,
      created_by: ctx.userId,
      updated_by: ctx.userId,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: "INSERT", tableName: "transporters", recordId: data.id, newValues: data });

  revalidatePath('/logistics/transporters');
  revalidatePath('/logistics/transfers');
  return { success: true, data };
}

export async function getStockTransfers() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('stock_transfers')
    .select(`
      *,
      source_location:locations!stock_transfers_source_location_id_fkey(id, name, location_type),
      destination_location:locations!stock_transfers_destination_location_id_fkey(id, name, location_type),
      transporter:transporters(id, legal_name, gstin),
      items:stock_transfer_items(
        id, product_id, source_batch_id, unit_of_measure,
        requested_qty, dispatched_qty, received_qty, unit_cost,
        product:products(id, name, product_code),
        batch:batch_register!stock_transfer_items_source_batch_id_fkey(id, batch_number, expiry_date)
      )
    `)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createStockTransfer(input: CreateStockTransferInput) {
  const parsed = createStockTransferSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Validation failed' };
  }

  const supabase = createClient();
  const ctx = await getUserContext();
  const payload = parsed.data;

  const { data: transfer, error: headerErr } = await supabase
    .from('stock_transfers')
    .insert({
      tenant_id: ctx.tenantId,
      organisation_id: ctx.organisationId,
      branch_id: ctx.branchId,
      transfer_no: payload.transfer_no.trim().toUpperCase(),
      transfer_date: payload.transfer_date,
      transfer_type: payload.transfer_type,
      status: 'DRAFT',
      source_location_id: payload.source_location_id,
      destination_location_id: payload.destination_location_id,
      cf_agent_id: payload.cf_agent_id || null,
      cnf_withdrawal_req_no: payload.cnf_withdrawal_req_no || null,
      cnf_company_approval_ref: payload.cnf_company_approval_ref || null,
      cnf_delivery_order_no: payload.cnf_delivery_order_no || null,
      transporter_id: payload.transporter_id || null,
      vehicle_no: payload.vehicle_no?.toUpperCase() || null,
      driver_name: payload.driver_name || null,
      driver_mobile: payload.driver_mobile || null,
      lr_rr_no: payload.lr_rr_no || null,
      eway_bill_no: payload.eway_bill_no || null,
      remarks: payload.remarks || null,
      created_by: ctx.userId,
      updated_by: ctx.userId,
    })
    .select()
    .single();

  if (headerErr || !transfer) {
    return { success: false, error: headerErr?.message ?? 'Failed to create stock transfer' };
  }

  const lineRows = payload.items.map((item) => ({
    tenant_id: ctx.tenantId,
    transfer_id: transfer.id,
    product_id: item.product_id,
    source_batch_id: item.source_batch_id,
    unit_of_measure: item.unit_of_measure,
    requested_qty: item.requested_qty,
    unit_cost: item.unit_cost,
    remarks: item.remarks || null,
  }));

  const { error: itemsErr } = await supabase.from('stock_transfer_items').insert(lineRows);
  if (itemsErr) return { success: false, error: itemsErr.message };

  await writeAuditLog({ ctx, action: "INSERT", tableName: "stock_transfers", recordId: transfer.id, newValues: { transfer_no: transfer.transfer_no } });

  revalidatePath('/logistics/transfers');
  return { success: true, data: transfer };
}

export async function dispatchStockTransfer(transferId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase.rpc('rpc_dispatch_stock_transfer', {
    p_tenant_id: ctx.tenantId,
    p_transfer_id: transferId,
    p_user_id: ctx.userId,
  });

  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: "DISPATCH", tableName: "stock_transfers", recordId: transferId, newValues: { status: "IN_TRANSIT" } });

  revalidatePath('/logistics/transfers');
  revalidatePath('/cf-management/withdrawals');
  revalidatePath('/cf-management/stock');
  revalidatePath('/inventory/ledger');
  revalidatePath('/inventory/batches');
  return { success: true };
}

export type ReceiptLineInput = { itemId: string; received: number; damaged: number };

/**
 * Receive an IN_TRANSIT transfer. Without `lines` everything is taken in intact; with `lines`
 * each item records received / damaged quantities and the remainder is booked as shortage.
 * Damaged + short stock is written off at cost to Transit Loss (migration 044).
 */
export async function receiveStockTransfer(transferId: string, lines?: ReceiptLineInput[], remarks?: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const items = lines
    ? lines.map((l) => ({ item_id: l.itemId, received: l.received, damaged: l.damaged }))
    : null;

  const { error } = await supabase.rpc('receive_stock_transfer', {
    p_transfer_id: transferId,
    p_items: items,
    p_remarks: remarks?.trim() || null,
  });

  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: "RECEIVE", tableName: "stock_transfers", recordId: transferId,
    newValues: { status: "RECEIVED", lines: lines?.length ?? 0 } });

  revalidatePath('/logistics/transfers');
  revalidatePath('/cf-management/withdrawals');
  revalidatePath('/cf-management/stock');
  revalidatePath('/inventory/ledger');
  revalidatePath('/inventory/batches');
  return { success: true };
}

/** DRAFT -> APPROVED. C&F withdrawals need the company's approval reference. */
export async function approveStockTransfer(transferId: string, approvalRef?: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase.rpc('approve_stock_transfer', {
    p_transfer_id: transferId,
    p_approval_ref: approvalRef?.trim() || null,
  });
  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: "APPROVE", tableName: "stock_transfers", recordId: transferId,
    newValues: { status: "APPROVED", approval_ref: approvalRef ?? null } });
  revalidatePath('/logistics/transfers');
  revalidatePath('/cf-management/withdrawals');
  return { success: true };
}

export async function getDeliveryChallans() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('delivery_challans')
    .select(`
      *,
      dispatch_location:locations(id, name),
      bill_to_party:parties!delivery_challans_bill_to_party_id_fkey(id, name, gstin),
      ship_to_party:parties!delivery_challans_ship_to_party_id_fkey(id, name, gstin),
      transporter:transporters(id, legal_name, gstin),
      items:delivery_challan_items(
        id, product_id, batch_id, unit_of_measure, qty, declared_unit_rate,
        product:products(id, name, product_code),
        batch:batch_register(id, batch_number)
      )
    `)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createDeliveryChallan(input: CreateDeliveryChallanInput) {
  const parsed = createDeliveryChallanSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Validation failed' };
  }

  const supabase = createClient();
  const ctx = await getUserContext();
  const payload = parsed.data;

  const { data: challan, error: headerErr } = await supabase
    .from('delivery_challans')
    .insert({
      tenant_id: ctx.tenantId,
      organisation_id: ctx.organisationId,
      branch_id: ctx.branchId,
      challan_no: payload.challan_no.trim().toUpperCase(),
      challan_date: payload.challan_date,
      purpose: payload.purpose,
      status: 'DISPATCHED',
      dispatch_location_id: payload.dispatch_location_id,
      bill_to_party_id: payload.bill_to_party_id || null,
      ship_to_party_id: payload.ship_to_party_id || null,
      consignee_name: payload.consignee_name.trim(),
      consignee_gstin: payload.consignee_gstin || null,
      delivery_address: payload.delivery_address.trim(),
      place_of_supply_state: payload.place_of_supply_state.trim(),
      transporter_id: payload.transporter_id || null,
      vehicle_no: payload.vehicle_no?.toUpperCase() || null,
      driver_name: payload.driver_name || null,
      driver_mobile: payload.driver_mobile || null,
      distance_km: payload.distance_km ?? null,
      eway_bill_no: payload.eway_bill_no || null,
      remarks: payload.remarks || null,
      created_by: ctx.userId,
      updated_by: ctx.userId,
    })
    .select()
    .single();

  if (headerErr || !challan) {
    return { success: false, error: headerErr?.message ?? 'Failed to create delivery challan' };
  }

  const itemRows = payload.items.map((item) => ({
    tenant_id: ctx.tenantId,
    challan_id: challan.id,
    product_id: item.product_id,
    batch_id: item.batch_id,
    unit_of_measure: item.unit_of_measure,
    qty: item.qty,
    declared_unit_rate: item.declared_unit_rate,
    remarks: item.remarks || null,
  }));

  const { error: itemErr } = await supabase.from('delivery_challan_items').insert(itemRows);
  if (itemErr) return { success: false, error: itemErr.message };

  await writeAuditLog({ ctx, action: "INSERT", tableName: "delivery_challans", recordId: challan.id, newValues: { challan_no: challan.challan_no } });

  revalidatePath('/logistics/challans');
  return { success: true, data: challan };
}
export async function getLogisticsFormLookups() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const [locationsRes, productsRes, batchesRes, partiesRes, transportersRes] = await Promise.all([
    supabase
      .from('locations')
      .select('id, name, location_type')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('products')
      .select('id, name, product_code, unit_of_measure')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('batch_register')
      .select('id, batch_number, product_id, location_id, current_qty, landing_cost_per_unit, unit_of_measure, expiry_date')
      .eq('tenant_id', ctx.tenantId)
      .eq('status', 'OPEN')
      .gt('current_qty', 0)
      .order('expiry_date', { ascending: true }),
    supabase
      .from('parties')
      .select('id, name, gstin, party_type')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('transporters')
      .select('id, transporter_code, legal_name, gstin')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .order('legal_name'),
  ]);

  return {
    locations: locationsRes.data ?? [],
    products: productsRes.data ?? [],
    batches: batchesRes.data ?? [],
    parties: partiesRes.data ?? [],
    transporters: transportersRes.data ?? [],
  };
}
