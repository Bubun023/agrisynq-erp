'use server';

import { createClient } from '@/lib/supabase/server';
import { getUserContext, writeAuditLog } from '@/actions/context';
import { revalidatePath } from 'next/cache';

// ─── Types ────────────────────────────────────────────────────

export type BankAccount = {
  id: string;
  account_name: string;
  account_no: string;
  bank_name: string;
  branch_name: string | null;
  ifsc_code: string | null;
  account_type: string;
  currency: string;
  opening_balance: number;
  opening_date: string;
  is_active: boolean;
  notes: string | null;
  current_balance?: number;
  unmatched_count?: number;
  last_stmt_date?: string | null;
};

export type BankStatementLine = {
  id: string;
  bank_account_id: string;
  import_batch_id: string | null;
  value_date: string;
  txn_date: string | null;
  description: string;
  ref_no: string | null;
  cheque_no: string | null;
  txn_type: 'CREDIT' | 'DEBIT';
  amount: number;
  balance: number | null;
  recon_status: 'UNMATCHED' | 'MATCHED' | 'MANUALLY_MATCHED' | 'EXCLUDED';
  matched_jv_id: string | null;
  matched_receipt_id: string | null;
  notes: string | null;
  account_name?: string;
  bank_name?: string;
  account_no?: string;
};

// ─── Bank Accounts — List ─────────────────────────────────────

export async function getBankAccounts() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('vw_bank_account_balance')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('account_name');

  if (error) throw new Error(`Bank accounts error: ${error.message}`);
  return data as BankAccount[];
}

// ─── Bank Accounts — Create ───────────────────────────────────

export async function createBankAccount(payload: {
  account_name: string;
  account_no: string;
  bank_name: string;
  branch_name?: string;
  ifsc_code?: string;
  account_type: string;
  opening_balance: number;
  opening_date: string;
  notes?: string;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('bank_accounts')
    .insert({
      organisation_id: ctx.organisationId,
      branch_id:       ctx.branchId ?? null,
      account_name:    payload.account_name,
      account_no:      payload.account_no,
      bank_name:       payload.bank_name,
      branch_name:     payload.branch_name ?? null,
      ifsc_code:       payload.ifsc_code ?? null,
      account_type:    payload.account_type,
      opening_balance: payload.opening_balance,
      opening_date:    payload.opening_date,
      notes:           payload.notes ?? null,
    })
    .select()
    .single();

  if (error) return { error: error.message };

  await writeAuditLog({ ctx, action: 'CREATE', tableName: 'bank_accounts', recordId: data.id, newValues: data });
  revalidatePath('/bank/accounts');
  return { data };
}

// ─── Bank Accounts — Toggle Active ────────────────────────────

export async function toggleBankAccountActive(id: string, isActive: boolean) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase
    .from('bank_accounts')
    .update({ is_active: isActive })
    .eq('id', id)
    .eq('organisation_id', ctx.organisationId);

  if (error) return { error: error.message };
  revalidatePath('/bank/accounts');
  return { success: true };
}

// ─── Bank Statements — List ───────────────────────────────────

export async function getBankStatements(filters: {
  bankAccountId?: string;
  fromDate?: string;
  toDate?: string;
  reconStatus?: string;
  txnType?: string;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('bank_statement_lines')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('value_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (filters.bankAccountId) query = query.eq('bank_account_id', filters.bankAccountId);
  if (filters.reconStatus)   query = query.eq('recon_status', filters.reconStatus);
  if (filters.txnType)       query = query.eq('txn_type', filters.txnType);
  if (filters.fromDate)      query = query.gte('value_date', filters.fromDate);
  if (filters.toDate)        query = query.lte('value_date', filters.toDate);

  const { data, error } = await query.limit(500);
  if (error) throw new Error(`Statement error: ${error.message}`);
  return data as BankStatementLine[];
}

// ─── Bank Statements — Import (CSV parsed on client) ─────────

export async function importBankStatementLines(payload: {
  bank_account_id: string;
  lines: {
    value_date: string;
    description: string;
    ref_no?: string;
    cheque_no?: string;
    txn_type: 'CREDIT' | 'DEBIT';
    amount: number;
    balance?: number;
  }[];
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!payload.lines.length) return { error: 'No lines to import.' };

  const batchId = crypto.randomUUID();

  const rows = payload.lines.map(l => ({
    organisation_id: ctx.organisationId,
    bank_account_id: payload.bank_account_id,
    import_batch_id: batchId,
    value_date:      l.value_date,
    description:     l.description,
    ref_no:          l.ref_no ?? null,
    cheque_no:       l.cheque_no ?? null,
    txn_type:        l.txn_type,
    amount:          l.amount,
    balance:         l.balance ?? null,
    recon_status:    'UNMATCHED' as const,
  }));

  const { data, error } = await supabase
    .from('bank_statement_lines')
    .insert(rows)
    .select();

  if (error) return { error: error.message };

  await writeAuditLog({
    ctx,
    action:    'IMPORT',
    tableName: 'bank_statement_lines',
    recordId:  batchId,
    newValues: { count: rows.length, bank_account_id: payload.bank_account_id },
  });

  revalidatePath('/bank/statements');
  revalidatePath('/bank/reconciliation');
  return { data, count: rows.length, batchId };
}

// ─── Bank Reconciliation — Match Line ────────────────────────

export async function matchStatementLine(payload: {
  line_id: string;
  matched_jv_id?: string;
  matched_receipt_id?: string;
  notes?: string;
}) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase
    .from('bank_statement_lines')
    .update({
      recon_status:       payload.matched_jv_id || payload.matched_receipt_id ? 'MATCHED' : 'MANUALLY_MATCHED',
      matched_jv_id:      payload.matched_jv_id      ?? null,
      matched_receipt_id: payload.matched_receipt_id ?? null,
      matched_at:         new Date().toISOString(),
      matched_by:         ctx.userId,
      notes:              payload.notes ?? null,
    })
    .eq('id', payload.line_id)
    .eq('organisation_id', ctx.organisationId);

  if (error) return { error: error.message };
  revalidatePath('/bank/reconciliation');
  return { success: true };
}

// ─── Bank Reconciliation — Unmatch ───────────────────────────

export async function unmatchStatementLine(lineId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase
    .from('bank_statement_lines')
    .update({
      recon_status:       'UNMATCHED',
      matched_jv_id:      null,
      matched_receipt_id: null,
      matched_at:         null,
      matched_by:         null,
    })
    .eq('id', lineId)
    .eq('organisation_id', ctx.organisationId);

  if (error) return { error: error.message };
  revalidatePath('/bank/reconciliation');
  return { success: true };
}

// ─── Bank Reconciliation — Exclude ───────────────────────────

export async function excludeStatementLine(lineId: string, notes?: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { error } = await supabase
    .from('bank_statement_lines')
    .update({ recon_status: 'EXCLUDED', notes: notes ?? null })
    .eq('id', lineId)
    .eq('organisation_id', ctx.organisationId);

  if (error) return { error: error.message };
  revalidatePath('/bank/reconciliation');
  return { success: true };
}

// ─── Lookup: Journal Vouchers for matching ────────────────────

export async function getJournalVouchersForMatching(search: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('journal_vouchers')
    .select('id, voucher_no, voucher_date, narration, total_debit')
    .eq('organisation_id', ctx.organisationId)
    .eq('status', 'POSTED')
    .ilike('voucher_no', `%${search}%`)
    .limit(20);

  if (error) throw new Error(error.message);
  return data ?? [];
}

// ─── Lookup: Receipts for matching ───────────────────────────

export async function getReceiptsForMatching(search: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('payment_receipts')
    .select('id, receipt_no, receipt_date, amount, payment_mode')
    .eq('organisation_id', ctx.organisationId)
    .ilike('receipt_no', `%${search}%`)
    .limit(20);

  if (error) throw new Error(error.message);
  return data ?? [];
}
