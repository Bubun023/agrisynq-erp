'use client';

import { useState, useTransition } from 'react';
import { lockPeriod, unlockPeriod } from '@/actions/admin';
import type { PeriodLock } from '@/actions/admin';

type Props = { initialLocks: PeriodLock[] };

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Build last 24 periods (current month going back)
function buildPeriodList() {
  const periods: { year: number; month: number; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: `${MONTH_NAMES[d.getMonth() + 1]} ${d.getFullYear()}` });
  }
  return periods;
}

export default function PeriodLocksClient({ initialLocks }: Props) {
  const [locks, setLocks]           = useState<PeriodLock[]>(initialLocks);
  const [unlockId, setUnlockId]     = useState<string | null>(null);
  const [unlockReason, setUnlockReason] = useState('');
  const [msg, setMsg]               = useState('');
  const [isPending, startTransition] = useTransition();

  const periods = buildPeriodList();

  function getLock(year: number, month: number) {
    return locks.find(l => l.period_year === year && l.period_month === month && l.is_locked);
  }

  function handleLock(year: number, month: number) {
    setMsg('');
    startTransition(async () => {
      const result = await lockPeriod(year, month);
      if (result.error) { setMsg('Error: ' + result.error); return; }
      const lock = result.data as PeriodLock;
      setLocks(prev => {
        const filtered = prev.filter(l => !(l.period_year === year && l.period_month === month));
        return [lock, ...filtered];
      });
      setMsg(`${MONTH_NAMES[month]} ${year} locked successfully.`);
    });
  }

  function handleUnlock(lockId: string) {
    if (!unlockReason.trim()) { setMsg('Please enter an unlock reason.'); return; }
    setMsg('');
    startTransition(async () => {
      const result = await unlockPeriod(lockId, unlockReason);
      if (result.error) { setMsg('Error: ' + result.error); return; }
      setLocks(prev => prev.map(l => l.id === lockId ? { ...l, is_locked: false, unlock_reason: unlockReason } : l));
      setUnlockId(null); setUnlockReason('');
      setMsg('Period unlocked.');
    });
  }

  const lockedCount = locks.filter(l => l.is_locked).length;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">Locked Periods</p>
          <p className="text-3xl font-bold text-red-700">{lockedCount}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">What does locking do?</p>
          <p className="text-xs text-slate-600">Prevents any new journal vouchers, invoices or receipts from being posted with a date in a locked period. Protects finalized accounts.</p>
        </div>
      </div>

      {msg && (
        <div className={`text-sm px-4 py-3 rounded-lg border ${msg.startsWith('Error') ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {msg}
        </div>
      )}

      {/* Periods Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <span className="font-semibold text-slate-800">Last 24 Periods</span>
        </div>
        <div className="divide-y divide-slate-100">
          {periods.map(p => {
            const lock = getLock(p.year, p.month);
            const isLocked = !!lock;

            return (
              <div key={`${p.year}-${p.month}`}
                className={`px-4 py-3 flex items-center justify-between ${isLocked ? 'bg-red-50' : 'hover:bg-slate-50'}`}>
                <div className="flex items-center gap-3">
                  <span className={`text-lg ${isLocked ? '🔒' : '🔓'}`}>{isLocked ? '🔒' : '🔓'}</span>
                  <div>
                    <span className="font-medium text-slate-800">{p.label}</span>
                    {isLocked && lock && (
                      <p className="text-xs text-red-600 mt-0.5">
                        Locked {lock.locked_at?.slice(0, 10)}
                        {lock.unlock_reason && <span className="text-slate-500"> | Prev reason: {lock.unlock_reason}</span>}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isLocked ? (
                    <>
                      {unlockId === lock?.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text" value={unlockReason}
                            onChange={e => setUnlockReason(e.target.value)}
                            placeholder="Reason for unlocking..."
                            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-green-500"
                          />
                          <button onClick={() => handleUnlock(lock!.id)} disabled={isPending}
                            className="px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 disabled:opacity-50">
                            {isPending ? '...' : 'Confirm Unlock'}
                          </button>
                          <button onClick={() => { setUnlockId(null); setUnlockReason(''); }}
                            className="px-3 py-1.5 bg-slate-100 text-slate-600 text-xs rounded-lg hover:bg-slate-200">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => { setUnlockId(lock!.id); setMsg(''); }}
                          className="px-3 py-1.5 bg-amber-100 text-amber-700 text-xs font-medium rounded-lg hover:bg-amber-200">
                          Unlock Period
                        </button>
                      )}
                    </>
                  ) : (
                    <button onClick={() => handleLock(p.year, p.month)} disabled={isPending}
                      className="px-3 py-1.5 bg-slate-100 text-slate-700 text-xs font-medium rounded-lg hover:bg-red-100 hover:text-red-700 disabled:opacity-50">
                      {isPending ? '...' : 'Lock Period'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
