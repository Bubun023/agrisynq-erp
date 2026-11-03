'use client';

import { useState } from 'react';
import PLReportClient    from './PLReportClient';
import AgeingReportClient from './AgeingReportClient';
import DayBookClient     from './DayBookClient';
import StockReportClient from './StockReportClient';
import type { PLRow, AgeingRow, DayBookRow, StockSummaryReportRow } from '@/actions/reports';

type Props = {
  plRows:      PLRow[];
  arRows:      AgeingRow[];
  apRows:      AgeingRow[];
  stockRows:   StockSummaryReportRow[];
  dayBookRows: DayBookRow[];
};

const TABS = [
  { key: 'pl',       label: 'P&L Statement', icon: '📊' },
  { key: 'ageing',   label: 'Ageing',         icon: '⏱️' },
  { key: 'stock',    label: 'Stock Summary',  icon: '📦' },
  { key: 'daybook',  label: 'Day Book',       icon: '📋' },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function ReportsTabShell({ plRows, arRows, apRows, stockRows, dayBookRows }: Props) {
  const [tab, setTab] = useState<TabKey>('pl');

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
              tab === t.key
                ? 'bg-green-700 text-white'
                : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}>
            <span>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'pl'      && <PLReportClient initialRows={plRows} />}
      {tab === 'ageing'  && <AgeingReportClient receivables={arRows} payables={apRows} />}
      {tab === 'stock'   && <StockReportClient rows={stockRows} />}
      {tab === 'daybook' && <DayBookClient initialRows={dayBookRows} />}
    </div>
  );
}
