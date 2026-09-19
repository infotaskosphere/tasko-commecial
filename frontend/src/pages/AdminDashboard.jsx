    { path: '/contact-details', icon: Phone, label: 'Contact Details', description: 'Manage company and department contact information.', color: '#0EA5E9' },
  ];
  return <div className="w-full min-w-0 p-3 sm:p-4 lg:p-6 space-y-4 sm:space-y-6">
    <HubBanner icon={ShieldCheck} eyebrow="Admin Control Plane" title="Administration" subtitle={`${scopeLabel}. Live figures below are read from the current tenant APIs; unavailable endpoints are not fabricated.`} isDark={isDark} />
    <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
      <FactCard icon={Users} label="User accounts" value={isLoading ? '…' : data?.users.length ?? '—'} detail="Current tenant user directory" color={HUB_COLORS.mediumBlue} isDark={isDark} />
      <FactCard icon={UserCheck} label="Active users" value={isLoading ? '…' : data?.activeUsers ?? '—'} detail="Not marked inactive" color={HUB_COLORS.emeraldGreen} isDark={isDark} />
      <FactCard icon={Building2} label="Company profiles" value={isLoading ? '…' : data?.companiesCount ?? '—'} detail="Visible to this administrator" color="#7C3AED" isDark={isDark} />
      <FactCard icon={Fingerprint} label="Roles" value={isLoading ? '…' : data?.roles.length ?? '—'} detail={isLoading ? 'Loading…' : `${data?.customRoles ?? 0} custom`} color="#DB2777" isDark={isDark} />
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">