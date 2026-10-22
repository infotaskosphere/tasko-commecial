import React, { useState } from 'react';
import api from '@/lib/api';
import { ErrorNote, Loading, SubNav, mutedCls, useLoad } from './ui.jsx';
import { EpsPanel, FxPanel, ProvisionsPanel, ReceivablesPanel, RelatedPartiesPanel } from './StandardsPartA.jsx';
import { BenefitsPanel, BorrowingPanel, LeasesPanel } from './StandardsPartB.jsx';

const SECTIONS = [
  ['receivables', 'Receivables'], ['provisions', 'Provisions'], ['fx', 'Foreign currency'], ['related', 'Related parties'],
  ['eps', 'EPS'], ['benefits', 'Employee benefits'], ['leases', 'Leases'], ['borrowing', 'Borrowing costs'],
];

export default function StandardsTab({ companyId, accounts, isDark, isAdmin }) {
  const [sub, setSub] = useState('receivables');
  const cat = useLoad(() => api.get('/accounting-books/standards/catalog', { params: { company_id: companyId } }).then((r) => r.data), [companyId]);
  if (cat.loading) return <Loading />;
  if (cat.error) return <ErrorNote error={cat.error} isDark={isDark} />;
  const { framework, standards } = cat.data;
  const common = { companyId, isDark, standards, framework };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SubNav isDark={isDark} value={sub} onChange={setSub} tabs={SECTIONS} label="Standards section" />
        <span className={`text-xs ${mutedCls(isDark)}`}>Following {framework === 'IND_AS' ? 'Ind AS' : 'ICAI AS'}</span>
      </div>
      {sub === 'receivables' && <ReceivablesPanel {...common} isAdmin={isAdmin} />}
      {sub === 'provisions' && <ProvisionsPanel {...common} accounts={accounts} />}
      {sub === 'fx' && <FxPanel {...common} />}
      {sub === 'related' && <RelatedPartiesPanel {...common} />}
      {sub === 'eps' && <EpsPanel {...common} />}
      {sub === 'benefits' && <BenefitsPanel {...common} />}
      {sub === 'leases' && <LeasesPanel {...common} />}
      {sub === 'borrowing' && <BorrowingPanel {...common} />}
    </div>
  );
}
