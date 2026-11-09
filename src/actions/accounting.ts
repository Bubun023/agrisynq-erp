'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getUserContext, writeAuditLog } from '@/actions/context';

// ============================================================================
// SCHEMAS
// ============================================================================

const accountSchema = z.object({
  account_code:         z.string().min(1, 'Account code is required').max(20),
  account_name:         z.string().min(2, 'Account name is required').max(200),
  account_type:         z.enum(['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY']),
  account_group:        z.string().max(100).optional().default(''),
  parent_account_id:    z.string().uuid().optional().nullable().or(z.literal('')),
  is_control_account:   z.boolean().optional().default(false),
  control_type:         z.enum(['DEBTOR', 'CREDITOR', 'BANK', 'CASH', 'STOCK', 'TAX']).optional().nullable(),
  opening_balance:      z.coerce.number().min(0).optional().default(0),
  opening_balance_type: z.enum(['DR', 'CR']).optional().default('DR'),
});

const jvLineSchema = z.object({
  account_id:    z.string().uuid('Select a valid account'),
  party_id:      z.string().uuid().optional().nullable().or(z.literal('')),
  debit_amount:  z.coerce.number().min(0),
  credit_amount: z.coerce.number().min(0),
  narration:     z.string().optional().nullable(),
  cost_center:   z.string().optional().nullable(),
}).refine(
  (d) => (d.debit_amount > 0 && d.credit_amount === 0) || (d.credit_amount > 0 && d.debit_amount === 0),
  { message: 'Each line must have either a debit OR credit amount, not both' }
);

const createJVSchema = z.object({
  voucher_no:   z.string().min(2, 'Voucher number is required'),
  voucher_date: z.string().min(1, 'Voucher date is required'),
  voucher_type: z.enum(['JOURNAL', 'PAYMENT', 'RECEIPT', 'CONTRA', 'PURCHASE', 'SALES', 'CREDIT_NOTE', 'DEBIT_NOTE']),
  narration:    z.string().optional().default(''),
  lines:        z.array(jvLineSchema).min(2, 'At least 2 lines required'),
}).refine((d) => {
  const totalDr = d.lines.reduce((s, l) => s + l.debit_amount, 0);
  const totalCr = d.lines.reduce((s, l) => s + l.credit_amount, 0);
  return Math.abs(totalDr - totalCr) < 0.001;
}, { message: 'Voucher does not balance — total debit must equal total credit' });

const receiptSchema = z.object({
  receipt_no:      z.string().min(2, 'Receipt number is required'),
  receipt_date:    z.string().min(1, 'Receipt date is required'),
  receipt_type:    z.enum(['RECEIPT', 'PAYMENT']),
  party_id:        z.string().uuid('Select a party'),
  bank_account_id: z.string().uuid().optional().nullable().or(z.literal('')),
  payment_mode:    z.enum(['CASH', 'CHEQUE', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'DD', 'OTHER']),
  amount:          z.coerce.number().positive('Amount must be greater than 0'),
  cheque_no:       z.string().optional().nullable(),
  cheque_date:     z.string().optional().nullable(),
  bank_name:       z.string().optional().nullable(),
  utr_no:          z.string().optional().nullable(),
  narration:       z.string().optional().nullable(),
});

export type CreateAccountInput  = z.infer<typeof accountSchema>;
export type CreateJVInput       = z.infer<typeof createJVSchema>;
export type CreateReceiptInput  = z.infer<typeof receiptSchema>;

// ============================================================================
// CHART OF ACCOUNTS
// ============================================================================

export async function getChartOfAccounts() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('*, parent:chart_of_accounts!parent_account_id(id, account_name, account_code)')
    .eq('tenant_id', ctx.tenantId)
    .order('account_code', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createAccount(input: CreateAccountInput) {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const supabase = createClient();
  const ctx = await getUserContext();
  const d = parsed.data;

  const { data, error } = await supabase
    .from('chart_of_accounts')
    .insert({
      tenant_id:            ctx.tenantId,
      organisation_id:      ctx.organisationId,
      branch_id:            ctx.branchId,
      account_code:         d.account_code.trim().toUpperCase(),
      account_name:         d.account_name.trim(),
      account_type:         d.account_type,
      account_group:        d.account_group ?? '',
      parent_account_id:    d.parent_account_id || null,
      is_control_account:   d.is_control_account ?? false,
      control_type:         d.control_type || null,
      opening_balance:      d.opening_balance ?? 0,
      opening_balance_type: d.opening_balance_type ?? 'DR',
      created_by:           ctx.userId,
      updated_by:           ctx.userId,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: 'INSERT', tableName: 'chart_of_accounts', recordId: data.id, newValues: data });
  revalidatePath('/accounting/accounts');
  revalidatePath('/accounting/vouchers');
  revalidatePath('/accounting/trial-balance');
  return { success: true, data };
}

export async function updateAccount(id: string, input: Partial<CreateAccountInput>) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase
    .from('chart_of_accounts')
    .update({ ...input, updated_by: ctx.userId })
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('is_system', false);   // never update system accounts

  if (error) return { success: false, error: error.message };
  revalidatePath('/accounting/accounts');
  revalidatePath('/accounting/trial-balance');
  return { success: true };
}

export async function seedSystemAccounts() {
  // Seeds a standard Indian agri-business chart of accounts for the tenant.
  const supabase = createClient();
  const ctx = await getUserContext();

  const SYSTEM_ACCOUNTS = [
    // Assets
    { code: '1001', name: 'Cash in Hand',           type: 'ASSET',     group: 'Current Assets',  ctrl: 'CASH'     },
    { code: '1002', name: 'Bank Account',            type: 'ASSET',     group: 'Current Assets',  ctrl: 'BANK'     },
    { code: '1010', name: 'Sundry Debtors',          type: 'ASSET',     group: 'Current Assets',  ctrl: 'DEBTOR'   },
    { code: '1020', name: 'Stock in Hand',           type: 'ASSET',     group: 'Current Assets',  ctrl: 'STOCK'    },
    { code: '1030', name: 'Advance to Suppliers',    type: 'ASSET',     group: 'Current Assets',  ctrl: null       },
    { code: '1040', name: 'Subsidy Receivable (Govt)', type: 'ASSET',  group: 'Current Assets',  ctrl: null       },
    { code: '1100', name: 'Fixed Assets',            type: 'ASSET',     group: 'Fixed Assets',    ctrl: null       },
    // Liabilities
    { code: '2001', name: 'Sundry Creditors',        type: 'LIABILITY', group: 'Current Liabilities', ctrl: 'CREDITOR' },
    { code: '2005', name: 'Goods Received - Invoice Pending', type: 'LIABILITY', group: 'Current Liabilities', ctrl: null },
    { code: '2010', name: 'GST Payable (CGST)',      type: 'LIABILITY', group: 'Tax Liabilities',  ctrl: 'TAX'     },
    { code: '2011', name: 'GST Payable (SGST)',      type: 'LIABILITY', group: 'Tax Liabilities',  ctrl: 'TAX'     },
    { code: '2012', name: 'GST Payable (IGST)',      type: 'LIABILITY', group: 'Tax Liabilities',  ctrl: 'TAX'     },
    { code: '2020', name: 'Advance from Customers',  type: 'LIABILITY', group: 'Current Liabilities', ctrl: null  },
    { code: '2100', name: 'Capital Account',         type: 'EQUITY',    group: 'Equity',           ctrl: null      },
    { code: '2110', name: 'Retained Earnings',       type: 'EQUITY',    group: 'Equity',           ctrl: null      },
    // Income
    { code: '3001', name: 'Sales — Fertilisers',     type: 'INCOME',    group: 'Direct Income',    ctrl: null      },
    { code: '3002', name: 'Sales — Seeds',           type: 'INCOME',    group: 'Direct Income',    ctrl: null      },
    { code: '3003', name: 'Sales — Pesticides',      type: 'INCOME',    group: 'Direct Income',    ctrl: null      },
    { code: '3010', name: 'FMS Subsidy Income',      type: 'INCOME',    group: 'Direct Income',    ctrl: null      },
    { code: '3020', name: 'Other Income',            type: 'INCOME',    group: 'Indirect Income',  ctrl: null      },
    // Expenses
    { code: '4001', name: 'Purchase — Fertilisers',  type: 'EXPENSE',   group: 'Direct Expenses',  ctrl: null      },
    { code: '4002', name: 'Purchase — Seeds',        type: 'EXPENSE',   group: 'Direct Expenses',  ctrl: null      },
    { code: '4003', name: 'Purchase — Pesticides',   type: 'EXPENSE',   group: 'Direct Expenses',  ctrl: null      },
    { code: '4010', name: 'Freight & Transport',     type: 'EXPENSE',   group: 'Direct Expenses',  ctrl: null      },
    { code: '4020', name: 'Salaries & Wages',        type: 'EXPENSE',   group: 'Indirect Expenses',ctrl: null      },
    { code: '4030', name: 'Rent & Rates',            type: 'EXPENSE',   group: 'Indirect Expenses',ctrl: null      },
    { code: '4050', name: 'Transit Loss / Stock Shortage', type: 'EXPENSE', group: 'Indirect Expenses', ctrl: null },
    { code: '4040', name: 'GST Input Credit (CGST)', type: 'ASSET',     group: 'Tax Assets',       ctrl: 'TAX'     },
    { code: '4041', name: 'GST Input Credit (SGST)', type: 'ASSET',     group: 'Tax Assets',       ctrl: 'TAX'     },
    { code: '4042', name: 'GST Input Credit (IGST)', type: 'ASSET',     group: 'Tax Assets',       ctrl: 'TAX'     },
  ];

  const rows = SYSTEM_ACCOUNTS.map((a) => ({
    tenant_id:            ctx.tenantId,
    organisation_id:      ctx.organisationId,
    account_code:         a.code,
    account_name:         a.name,
    account_type:         a.type as 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE' | 'EQUITY',
    account_group:        a.group,
    is_control_account:   !!a.ctrl,
    control_type:         (a.ctrl as 'DEBTOR' | 'CREDITOR' | 'BANK' | 'CASH' | 'STOCK' | 'TAX' | null) || null,
    opening_balance:      0,
    opening_balance_type: 'DR' as const,
    is_system:            true,
    created_by:           ctx.userId,
    updated_by:           ctx.userId,
  }));

  const { error } = await supabase
    .from('chart_of_accounts')
    .upsert(rows, { onConflict: 'tenant_id,account_code', ignoreDuplicates: true });

  if (error) return { success: false, error: error.message };
  revalidatePath('/accounting/accounts');
  return { success: true, count: rows.length };
}

// ============================================================================
// JOURNAL VOUCHERS
// ============================================================================

export async function getJournalVouchers() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('journal_vouchers')
    .select(`
      *,
      lines:journal_voucher_lines(
        id, line_no, debit_amount, credit_amount, narration, cost_center,
        account:chart_of_accounts(id, account_code, account_name, account_type)
      )
    `)
    .eq('tenant_id', ctx.tenantId)
    .order('voucher_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createJournalVoucher(input: CreateJVInput) {
  const parsed = createJVSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Validation failed' };

  const supabase = createClient();
  const ctx = await getUserContext();
  const d = parsed.data;

  const totalDr = d.lines.reduce((s, l) => s + l.debit_amount, 0);
  const totalCr = d.lines.reduce((s, l) => s + l.credit_amount, 0);

  const { data: jv, error: jvErr } = await supabase
    .from('journal_vouchers')
    .insert({
      tenant_id:      ctx.tenantId,
      organisation_id: ctx.organisationId,
      branch_id:      ctx.branchId,
      voucher_no:     d.voucher_no.trim().toUpperCase(),
      voucher_date:   d.voucher_date,
      voucher_type:   d.voucher_type,
      narration:      d.narration ?? '',
      status:         'DRAFT',
      total_debit:    totalDr,
      total_credit:   totalCr,
      created_by:     ctx.userId,
      updated_by:     ctx.userId,
    })
    .select()
    .single();

  if (jvErr || !jv) return { success: false, error: jvErr?.message ?? 'Failed to create voucher' };

  const lineRows = d.lines.map((l, i) => ({
    tenant_id:    ctx.tenantId,
    voucher_id:   jv.id,
    line_no:      i + 1,
    account_id:   l.account_id,
    party_id:     l.party_id || null,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
    narration:    l.narration || null,
    cost_center:  l.cost_center || null,
  }));

  const { error: linesErr } = await supabase.from('journal_voucher_lines').insert(lineRows);
  if (linesErr) return { success: false, error: linesErr.message };

  await writeAuditLog({ ctx, action: 'INSERT', tableName: 'journal_vouchers', recordId: jv.id, newValues: { voucher_no: jv.voucher_no } });
  revalidatePath('/accounting/vouchers');
  return { success: true, data: jv };
}

export async function postJournalVoucher(id: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase.rpc('rpc_post_journal_voucher', {
    p_tenant_id:  ctx.tenantId,
    p_voucher_id: id,
    p_user_id:    ctx.userId,
  });

  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: 'POST', tableName: 'journal_vouchers', recordId: id, newValues: { status: 'POSTED' } });
  revalidatePath('/accounting/vouchers');
  revalidatePath('/accounting/trial-balance');
  return { success: true };
}

// ============================================================================
// PAYMENT RECEIPTS
// ============================================================================

export async function getPaymentReceipts() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('payment_receipts')
    .select(`
      *,
      party:parties(id, name, gstin, party_type),
      bank_account:chart_of_accounts!payment_receipts_bank_account_id_fkey(id, account_code, account_name),
      allocations:receipt_allocations(id, invoice_type, invoice_id, allocated_amount)
    `)
    .eq('tenant_id', ctx.tenantId)
    .order('receipt_date', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createPaymentReceipt(input: CreateReceiptInput) {
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Validation failed' };

  const supabase = createClient();
  const ctx = await getUserContext();
  const d = parsed.data;

  const { data, error } = await supabase
    .from('payment_receipts')
    .insert({
      tenant_id:       ctx.tenantId,
      organisation_id: ctx.organisationId,
      branch_id:       ctx.branchId,
      receipt_no:      d.receipt_no.trim().toUpperCase(),
      receipt_date:    d.receipt_date,
      receipt_type:    d.receipt_type,
      party_id:        d.party_id,
      bank_account_id: d.bank_account_id || null,
      payment_mode:    d.payment_mode,
      amount:          d.amount,
      cheque_no:       d.cheque_no || null,
      cheque_date:     d.cheque_date || null,
      bank_name:       d.bank_name || null,
      utr_no:          d.utr_no || null,
      narration:       d.narration || null,
      status:          'DRAFT',
      created_by:      ctx.userId,
      updated_by:      ctx.userId,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: 'INSERT', tableName: 'payment_receipts', recordId: data.id, newValues: { receipt_no: data.receipt_no } });
  revalidatePath('/accounting/receipts');
  return { success: true, data };
}

/**
 * Posts a DRAFT receipt/payment. If no allocations were recorded, the amount is
 * automatically allocated oldest-due-first to the party's outstanding invoices.
 * Everything else (journal, invoice outstanding update) happens atomically in
 * rpc_post_payment_receipt (migrations 030/037).
 */
export async function postPaymentReceipt(receiptId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data: rc, error: rcErr } = await supabase
    .from('payment_receipts')
    .select('id, receipt_type, party_id, amount, payment_mode, bank_account_id, status')
    .eq('id', receiptId)
    .eq('tenant_id', ctx.tenantId)
    .single();
  if (rcErr || !rc) return { success: false, error: 'Receipt not found.' };
  if (rc.status !== 'DRAFT') return { success: false, error: 'Only DRAFT receipts can be posted.' };

  const { data: accts } = await supabase
    .from('chart_of_accounts')
    .select('id, account_code')
    .eq('tenant_id', ctx.tenantId)
    .in('account_code', ['1001', '1002', '1010', '2001']);
  const byCode: Record<string, string> = Object.fromEntries((accts ?? []).map((a) => [a.account_code, a.id]));
  const cashOrBank = rc.bank_account_id ?? (rc.payment_mode === 'CASH' ? byCode['1001'] : byCode['1002']);
  const partyAcct = rc.receipt_type === 'RECEIPT' ? byCode['1010'] : byCode['2001'];
  if (!cashOrBank || !partyAcct) {
    return { success: false, error: 'Chart of accounts is incomplete. Seed the chart of accounts first.' };
  }

  // Auto-allocate (FIFO by due date) when the user did not allocate manually
  const { count } = await supabase
    .from('receipt_allocations')
    .select('id', { count: 'exact', head: true })
    .eq('receipt_id', receiptId);
  if (!count) {
    const isReceipt = rc.receipt_type === 'RECEIPT';
    const { data: invs } = await supabase
      .from(isReceipt ? 'sales_invoices' : 'purchase_invoices')
      .select('id, outstanding_amount')
      .eq('tenant_id', ctx.tenantId)
      .eq(isReceipt ? 'customer_id' : 'supplier_id', rc.party_id)
      .eq('status', 'POSTED')
      .gt('outstanding_amount', 0)
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('invoice_date', { ascending: true });

    let remaining = Number(rc.amount);
    const rows: { tenant_id: string; receipt_id: string; invoice_type: string; invoice_id: string; allocated_amount: number }[] = [];
    for (const inv of invs ?? []) {
      if (remaining <= 0.001) break;
      const take = Math.min(remaining, Number(inv.outstanding_amount));
      rows.push({
        tenant_id: ctx.tenantId, receipt_id: receiptId,
        invoice_type: isReceipt ? 'SALES_INVOICE' : 'PURCHASE_INVOICE',
        invoice_id: inv.id, allocated_amount: Math.round(take * 100) / 100,
      });
      remaining -= take;
    }
    if (rows.length) {
      const { error: allocErr } = await supabase.from('receipt_allocations').insert(rows);
      if (allocErr) return { success: false, error: allocErr.message };
    }
  }

  const { error } = await supabase.rpc('rpc_post_payment_receipt', {
    p_tenant_id:      ctx.tenantId,
    p_receipt_id:     receiptId,
    p_user_id:        ctx.userId,
    p_debit_account:  rc.receipt_type === 'RECEIPT' ? cashOrBank : partyAcct,
    p_credit_account: rc.receipt_type === 'RECEIPT' ? partyAcct : cashOrBank,
  });
  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: 'POST', tableName: 'payment_receipts', recordId: receiptId, newValues: { status: 'POSTED' } });
  revalidatePath('/accounting/receipts');
  revalidatePath('/accounting/ar');
  revalidatePath('/accounting/ap');
  revalidatePath('/accounting/trial-balance');
  return { success: true };
}

// ============================================================================
// TRIAL BALANCE
// ============================================================================

export async function getTrialBalance() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('vw_trial_balance')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .order('account_code', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

// ============================================================================
// AR / AP AGEING
// ============================================================================

type AgeingInvoiceRow = {
  id: string; invoice_no: string; invoice_date: string; due_date: string | null;
  grand_total: number; amount_paid: number; outstanding: number; daysOverdue: number;
  party: { id: string; name: string; gstin: string | null } | null;
};

function toAgeingRow(
  inv: {
    id: string; invoice_number: string; invoice_date: string; due_date: string | null;
    total: number; paid: number; party: unknown;
  },
  today: string
): AgeingInvoiceRow | null {
  const outstanding = Math.round((Number(inv.total) - Number(inv.paid)) * 100) / 100;
  if (outstanding <= 0.001) return null;
  const dueDate = inv.due_date ?? inv.invoice_date;
  const daysOverdue = Math.floor((new Date(today).getTime() - new Date(dueDate).getTime()) / 86400000);
  const party = Array.isArray(inv.party) ? inv.party[0] : inv.party;
  return {
    id: inv.id, invoice_no: inv.invoice_number, invoice_date: inv.invoice_date, due_date: inv.due_date,
    grand_total: Number(inv.total), amount_paid: Number(inv.paid), outstanding, daysOverdue,
    party: (party as AgeingInvoiceRow['party']) ?? null,
  };
}

export async function getReceivablesAgeing(): Promise<AgeingInvoiceRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('sales_invoices')
    .select('id, invoice_number, invoice_date, due_date, net_receivable, amount_received, party:parties!customer_id(id, name, gstin)')
    .eq('tenant_id', ctx.tenantId)
    .eq('organisation_id', ctx.organisationId)
    .eq('status', 'POSTED')
    .order('due_date', { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? [])
    .map((i) => toAgeingRow({ ...i, total: i.net_receivable, paid: i.amount_received }, today))
    .filter((r): r is AgeingInvoiceRow => r !== null);
}

export async function getPayablesAgeing(): Promise<AgeingInvoiceRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('purchase_invoices')
    .select('id, invoice_number, invoice_date, due_date, net_payable, amount_paid, party:parties!supplier_id(id, name, gstin)')
    .eq('tenant_id', ctx.tenantId)
    .eq('organisation_id', ctx.organisationId)
    .eq('status', 'POSTED')
    .order('due_date', { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? [])
    .map((i) => toAgeingRow({ ...i, total: i.net_payable, paid: i.amount_paid }, today))
    .filter((r): r is AgeingInvoiceRow => r !== null);
}

// ============================================================================
// LOOKUPS
// ============================================================================

export async function getAccountingLookups() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const [accountsRes, partiesRes] = await Promise.all([
    supabase
      .from('chart_of_accounts')
      .select('id, account_code, account_name, account_type, is_control_account, control_type')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .order('account_code'),
    supabase
      .from('parties')
      .select('id, name, gstin, party_type')
      .eq('tenant_id', ctx.tenantId)
      .eq('is_active', true)
      .order('name'),
  ]);

  return {
    accounts:  accountsRes.data  ?? [],
    parties:   partiesRes.data   ?? [],
  };
}
