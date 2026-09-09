// Admin → Master Data: canonical company, client and user administration hub.
import React from 'react';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { CompanyProfilesList } from '@/components/CompanyProfiles';
import CompanyUserManager from '@/components/CompanyUserManager';
import PlatformUserManager from '@/components/PlatformUserManager';
import MasterDataClientManager from '@/components/MasterDataClientManager';
import CommercialCompanyDirectory from '@/components/CommercialCompanyDirectory';
import { PageShell, PageBanner } from '@/components/ui/PageKit';
import '../../master-data-commercial.css';

export default function MasterData() {
  // Read the shared flag from AuthContext rather than re-deriving it locally —
  // this file previously kept its own copy of PLATFORM_OWNER_EMAIL, which is
  // exactly the kind of duplication that let the sidebar shortcut and this
  // page's own owner check drift out of sync with each other.
  const { isPlatformOwner: platformOwner } = useAuth();

  return (
    <PageShell className="master-data-page-shell">
      <PageBanner
        eyebrow="Admin"
        title="Master Data"
        subtitle="Manage company profiles, clients and customer users from one controlled master-data workspace."
      />

      {platformOwner ? (
        <CommercialCompanyDirectory />
      ) : (
        <div className="master-data-company-section">
          <CompanyProfilesList />
        </div>
      )}

      {/* Platform Owner is the commercial control plane, not a customer
          operational superadmin. Client records therefore remain completely
          tenant-scoped and are only rendered for customer administrators. */}
      {!platformOwner && <MasterDataClientSection />}

      <MasterDataUserSection platformOwner={platformOwner} />
    </PageShell>
  );
}

function MasterDataClientSection() {
  return <MasterDataSectionShell className="master-data-client-card"><MasterDataClientManager /></MasterDataSectionShell>;
}

function MasterDataUserSection({ platformOwner }) {
  return (
    <MasterDataSectionShell className="master-data-user-card">
      {platformOwner ? <div id="users"><PlatformUserManager /></div> : <div id="users"><CompanyUserManager /></div>}
    </MasterDataSectionShell>
  );
}

function MasterDataSectionShell({ className = '', children }) {
  return <div className={`master-data-section-shell ${className}`}>{children}</div>;
}
