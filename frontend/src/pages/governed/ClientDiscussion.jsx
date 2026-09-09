// ClientDiscussion.jsx — dedicated Client Proposals discussion workspace.
import React from 'react';
import { MessagesSquare } from 'lucide-react';
import GovernedListPage from '@/components/governance/GovernedListPage';

export default function ClientDiscussion() {
  return (
    <GovernedListPage
      title="Client Discussion"
      description="Discussion threads with clients."
      apiPath="/client-discussion"
      module="proposals"
      pageFlag="can_view_client_discussion"
      icon={MessagesSquare}
      eyebrow="Client Proposals"
      width="wide"
    />
  );
}
