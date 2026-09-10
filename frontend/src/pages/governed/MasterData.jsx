// Admin → Master Data: canonical company, client and user administration hub.
import React from 'react';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { CompanyProfilesList } from '@/components/CompanyProfiles';
import CompanyUserManager from '@/components/CompanyUserManager';
import MasterDataClientManager from '@/components/MasterDataClientManager';
import { PageShell, PageBanner } from '@/components/ui/PageKit';
import '../../master-data-commercial.css';

export default function MasterData() {
  const { isPlatformOwner: platformOwner } = useAuth();

  return (
    <PageShell className="master-data-page-shell">
      <PageBanner
        eyebrow="Admin"
        title="Master Data"
        subtitle="Manage company profiles, clients and staff users from one controlled master-data workspace."
      />

      <div className="master-data-company-section">
        <CompanyProfilesList />
      </div>

      <MasterDataClientSection />

      <MasterDataUserSection platformOwner={platformOwner} />
    </PageShell>
  );
}

function MasterDataClientSection() {
  return (
    <MasterDataSectionShell className="master-data-client-card">
      <MasterDataClientManager />
    </MasterDataSectionShell>
  );
}

function MasterDataUserSection() {
  return (
    <MasterDataSectionShell className="master-data-user-card">
      <CompanyUserManager />
    </MasterDataSectionShell>
  );
}

function MasterDataSectionShell({ className = '', children }) {
  return <div className={`master-data-section-shell ${className}`}>{children}</div>;
}
