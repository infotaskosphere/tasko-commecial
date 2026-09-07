// Admin → Master Data: canonical company, client and user administration hub.
import React, { useEffect, useState } from 'react';
import api from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { CompanyProfilesList } from '@/components/CompanyProfiles';
import CompanyUserManager from '@/components/CompanyUserManager';
import PlatformUserManager from '@/components/PlatformUserManager';
import { PageShell, PageBanner } from '@/components/ui/PageKit';
import '../../master-data-commercial.css';

const PLATFORM_OWNER_EMAIL = 'info.taskosphere@gmail.com';

export default function MasterData() {
  const { user } = useAuth();
  const platformOwner = String(user?.email || '').trim().toLowerCase() === PLATFORM_OWNER_EMAIL;
  const [companies, setCompanies] = useState([]);

  useEffect(() => {
    if (!platformOwner) return;
    api.get('/companies')
      .then(r => setCompanies(Array.isArray(r.data) ? r.data : []))
      .catch(() => setCompanies([]));
  }, [platformOwner]);

  return (
    <PageShell className="master-data-page-shell">
      <PageBanner
        eyebrow="Admin"
        title="Master Data"
        subtitle="Manage company profiles, clients and customer users from one controlled master-data workspace."
      />

      <div className="master-data-company-section">
        <CompanyProfilesList />
      </div>

      <MasterDataClientSection />

      <MasterDataUserSection platformOwner={platformOwner} companies={companies} />
    </PageShell>
  );
}

function MasterDataClientSection() {
  return <MasterDataSectionShell className="master-data-client-card"><CompanyUserManager /></MasterDataSectionShell>;
}

function MasterDataUserSection({ platformOwner, companies }) {
  return (
    <MasterDataSectionShell className="master-data-user-card">
      {platformOwner ? <div id="users"><PlatformUserManager companies={companies} /></div> : <div id="users"><CompanyUserManager /></div>}
    </MasterDataSectionShell>
  );
}

function MasterDataSectionShell({ className = '', children }) {
  return <div className={`master-data-section-shell ${className}`}>{children}</div>;
}
