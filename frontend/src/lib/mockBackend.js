/**
 * mockBackend.js
 * In-memory mock response provider for Taskosphere Commercial
 * Allows full offline / preview functionality without requiring an external MongoDB/Python instance.
 */

export function derivePermissionsFromModules(modules) {
  const norm = (modules || []).map((m) => String(m).toLowerCase().replace(/-/g, "_"));
  return {
    can_access_taskosphere: norm.some((m) => m === "taskosphere" || m === "tasks"),
    can_access_finix: norm.some((m) => m === "finix" || m === "invoicing" || m === "accounting"),
    can_access_compliance: norm.some((m) => m === "compliance"),
    can_access_records: norm.some((m) => m === "records"),
    can_access_proposals: norm.some((m) => m === "proposals" || m === "client_proposals"),
    can_access_people_matrix: norm.some((m) => m === "people_matrix" || m === "hrms" || m === "peoplematrix"),
  };
}

export const DEFAULT_MOCK_LICENSES = [
  {
    id: "lic-01",
    customer_id: "cust-mda-01",
    license_key: "TSO-COMM-2026-DEMO-0001",
    company_name: "Manthan Desai And Associates",
    package_name: "Taskosphere Custom",
    status: "active",
    valid_until: "2027-12-31T23:59:59Z",
    max_users: 100,
    max_installations: 5,
    modules: ["taskosphere"],
    licensed_modules: ["taskosphere"],
    selected_features: {
      taskosphere: ["tasks_view", "tasks_create", "tasks_edit", "tasks_delete", "dashboard_view", "attendance_view", "reminders_view", "action_center_view", "client_visits_view", "ai_reader_view"],
    },
  },
];

export const DEFAULT_MOCK_CUSTOMERS = [
  {
    id: "cust-mda-01",
    company_name: "Manthan Desai And Associates",
    contact_name: "Manthan P Desai",
    email: "director@desaiassociates.com",
    phone: "+91 98765 43210",
    gstin: "27AAACD1234F1Z5",
    address: "101, Business Center, Mumbai",
    status: "active",
    licensed_modules: ["taskosphere"],
    selected_features: {
      taskosphere: ["tasks_view", "tasks_create", "tasks_edit", "tasks_delete", "dashboard_view", "attendance_view", "reminders_view", "action_center_view", "client_visits_view", "ai_reader_view"],
    },
  },
];

export function getStoredMockLicenses() {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const stored = window.localStorage.getItem("taskosphere_mock_licenses");
      if (stored) return JSON.parse(stored);
    } catch {}
  }
  if (!globalThis.__mockLicenses) {
    globalThis.__mockLicenses = JSON.parse(JSON.stringify(DEFAULT_MOCK_LICENSES));
  }
  return globalThis.__mockLicenses;
}

export function saveStoredMockLicenses(licenses) {
  globalThis.__mockLicenses = licenses;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem("taskosphere_mock_licenses", JSON.stringify(licenses));
    } catch {}
  }
}

export function getStoredMockCustomers() {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const stored = window.localStorage.getItem("taskosphere_mock_customers");
      if (stored) return JSON.parse(stored);
    } catch {}
  }
  if (!globalThis.__mockCustomers) {
    globalThis.__mockCustomers = JSON.parse(JSON.stringify(DEFAULT_MOCK_CUSTOMERS));
  }
  return globalThis.__mockCustomers;
}

export function saveStoredMockCustomers(customers) {
  globalThis.__mockCustomers = customers;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem("taskosphere_mock_customers", JSON.stringify(customers));
    } catch {}
  }
}

export const MOCK_USER = {
  id: "lic-usr-01",
  email: "director@desaiassociates.com",
  full_name: "Manthan P Desai",
  role: "admin",
  company_id: "cust-mda-01",
  commercial_customer_id: "cust-mda-01",
  license_id: "lic-01",
  company: {
    id: "cust-mda-01",
    name: "Manthan Desai And Associates",
    plan: "Taskosphere",
  },
  subscription: {
    status: "active",
    package_id: "taskosphere",
    valid_until: "2030-12-31T23:59:59Z",
  },
  licensed_modules: ["taskosphere"],
  selected_features: {
    taskosphere: ["tasks_view", "tasks_create", "tasks_edit", "tasks_delete", "dashboard_view", "attendance_view", "reminders_view", "action_center_view", "client_visits_view", "ai_reader_view"],
  },
  permissions: {
    can_access_taskosphere: true,
    can_access_finix: false,
    can_access_compliance: false,
    can_access_records: false,
    can_access_proposals: false,
    can_access_people_matrix: false,
  },
};

export const MOCK_TASKS = [
  {
    id: "task-101",
    _id: "task-101",
    title: "GST-3B Monthly Filing - May 2026",
    description: "Reconcile sales and purchase registers and file GSTR-3B before the 20th.",
    status: "in_progress",
    priority: "high",
    client_name: "Apex Global Logistics Pvt Ltd",
    client_id: "cli-01",
    due_date: "2026-05-20",
    assigned_to: "Admin User",
    category: "GST Compliance",
    created_at: "2026-05-01T09:00:00Z",
  },
  {
    id: "task-102",
    _id: "task-102",
    title: "ROC Form AOC-4 & MGT-7 Filing",
    description: "Annual financial statement and annual return filing with MCA portal.",
    status: "pending",
    priority: "urgent",
    client_name: "Zenith Infotech Solutions Ltd",
    client_id: "cli-02",
    due_date: "2026-05-30",
    assigned_to: "Rohan Verma",
    category: "ROC Compliance",
    created_at: "2026-05-02T11:30:00Z",
  },
  {
    id: "task-103",
    _id: "task-103",
    title: "Statutory Tax Audit FY 2025-26",
    description: "Complete 3CD checklist verification and vouching of capital expenditures.",
    status: "in_progress",
    priority: "medium",
    client_name: "Starlight Pharma Healthcare",
    client_id: "cli-03",
    due_date: "2026-06-15",
    assigned_to: "Priya Sharma",
    category: "Income Tax",
    created_at: "2026-05-05T14:15:00Z",
  },
  {
    id: "task-104",
    _id: "task-104",
    title: "TDS Return 26Q Q4 Verification",
    description: "Reconcile Challan payment details with Form 16A generation queue.",
    status: "completed",
    priority: "low",
    client_name: "Blue Horizon Exports",
    client_id: "cli-04",
    due_date: "2026-05-10",
    assigned_to: "Admin User",
    category: "Direct Tax",
    created_at: "2026-04-28T10:00:00Z",
  },
];

export const MOCK_CLIENTS = [
  {
    id: "cli-01",
    _id: "cli-01",
    name: "Apex Global Logistics Pvt Ltd",
    company_name: "Apex Global Logistics Pvt Ltd",
    pan: "AABCA1234F",
    gstin: "27AABCA1234F1Z5",
    cin: "U74999MH2018PTC312345",
    email: "accounts@apexlogistics.in",
    phone: "+91 98200 12345",
    city: "Mumbai",
    state: "Maharashtra",
    status: "active",
    contact_person: "Rajesh Kulkarni",
  },
  {
    id: "cli-02",
    _id: "cli-02",
    name: "Zenith Infotech Solutions Ltd",
    company_name: "Zenith Infotech Solutions Ltd",
    pan: "AAACZ5678K",
    gstin: "29AAACZ5678K1Z2",
    cin: "L72200KA2012PLC065432",
    email: "finance@zenithinfo.com",
    phone: "+91 98450 67890",
    city: "Bengaluru",
    state: "Karnataka",
    status: "active",
    contact_person: "Suresh Menon",
  },
  {
    id: "cli-03",
    _id: "cli-03",
    name: "Starlight Pharma Healthcare",
    company_name: "Starlight Pharma Healthcare",
    pan: "AALCS9876P",
    gstin: "24AALCS9876P1ZX",
    cin: "U24230GJ2020PTC115566",
    email: "compliance@starlightpharma.com",
    phone: "+91 99789 54321",
    city: "Ahmedabad",
    state: "Gujarat",
    status: "active",
    contact_person: "Dr. Ananya Patel",
  },
  {
    id: "cli-04",
    _id: "cli-04",
    name: "Blue Horizon Exports",
    company_name: "Blue Horizon Exports",
    pan: "AAGCB4321M",
    gstin: "07AAGCB4321M1ZN",
    cin: "U51909DL2019PTC345678",
    email: "billing@bluehorizon.net",
    phone: "+91 98111 88888",
    city: "New Delhi",
    state: "Delhi",
    status: "active",
    contact_person: "Vikram Malhotra",
  },
];

export const MOCK_INVOICES = [
  {
    id: "inv-2026-001",
    _id: "inv-2026-001",
    invoice_number: "TSO/26-27/001",
    client_name: "Apex Global Logistics Pvt Ltd",
    client_id: "cli-01",
    amount: 45000,
    gst_amount: 8100,
    total: 53100,
    date: "2026-05-01",
    due_date: "2026-05-15",
    status: "paid",
  },
  {
    id: "inv-2026-002",
    _id: "inv-2026-002",
    invoice_number: "TSO/26-27/002",
    client_name: "Zenith Infotech Solutions Ltd",
    client_id: "cli-02",
    amount: 120000,
    gst_amount: 21600,
    total: 141600,
    date: "2026-05-04",
    due_date: "2026-05-18",
    status: "pending",
  },
  {
    id: "inv-2026-003",
    _id: "inv-2026-003",
    invoice_number: "TSO/26-27/003",
    client_name: "Starlight Pharma Healthcare",
    client_id: "cli-03",
    amount: 75000,
    gst_amount: 13500,
    total: 88500,
    date: "2026-05-06",
    due_date: "2026-05-20",
    status: "draft",
  },
];

export const MOCK_COMPLIANCE = [
  {
    id: "comp-01",
    act: "GST",
    form: "GSTR-3B",
    period: "May 2026",
    due_date: "2026-05-20",
    applicable_clients: 4,
    filed_count: 2,
    pending_count: 2,
    status: "active",
  },
  {
    id: "comp-02",
    act: "Income Tax",
    form: "TDS Payment (Challan 281)",
    period: "April 2026",
    due_date: "2026-05-07",
    applicable_clients: 4,
    filed_count: 4,
    pending_count: 0,
    status: "completed",
  },
  {
    id: "comp-03",
    act: "MCA / Companies Act",
    form: "DIR-3 KYC",
    period: "FY 2025-26",
    due_date: "2026-09-30",
    applicable_clients: 8,
    filed_count: 5,
    pending_count: 3,
    status: "active",
  },
];

export function handleMockRoute(method, url, data) {
  const normUrl = url.replace(/^\/api/, "").split("?")[0];

  const getActiveMockUser = () => {
    const licenses = getStoredMockLicenses();
    const activeLic = licenses.find((l) => l.id === MOCK_USER.license_id || l.customer_id === MOCK_USER.company_id) || licenses[0];
    const userModules = activeLic ? (activeLic.modules || activeLic.licensed_modules || ["taskosphere"]) : ["taskosphere"];
    const perms = derivePermissionsFromModules(userModules);
    return {
      ...MOCK_USER,
      licensed_modules: userModules,
      selected_features: activeLic?.selected_features || MOCK_USER.selected_features || {},
      permissions: {
        ...(MOCK_USER.permissions || {}),
        ...perms,
      },
    };
  };

  if (normUrl === "/auth/login" || normUrl === "/auth/signin") {
    const email = String(data?.email || "").trim().toLowerCase();
    const isPlatformOwner = email === "info.taskosphere@gmail.com" || email === "admin@taskosphere.com";
    const newSessionToken = "sess_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);

    if (typeof window !== "undefined" && window.localStorage && !isPlatformOwner && email) {
      window.localStorage.setItem("tasko_active_session_" + email, newSessionToken);
    }

    const activeUser = getActiveMockUser();
    if (email) activeUser.email = email;
    return {
      status: 200,
      data: {
        access_token: `mock-jwt-token-${email || "user"}-${newSessionToken}`,
        token: `mock-jwt-token-${email || "user"}-${newSessionToken}`,
        session_token: newSessionToken,
        user: activeUser,
      },
    };
  }

  if (normUrl === "/auth/me") {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = window.localStorage.getItem("user") || window.sessionStorage.getItem("user");
      const currentSessToken = window.localStorage.getItem("session_token") || window.sessionStorage.getItem("session_token");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          const email = String(parsed?.email || "").trim().toLowerCase();
          const isPlatformOwner = email === "info.taskosphere@gmail.com" || parsed?.id === "usr-admin-01" || parsed?.id === "saas-bootstrap-admin";
          if (!isPlatformOwner && email && currentSessToken) {
            const activeToken = window.localStorage.getItem("tasko_active_session_" + email);
            if (activeToken && activeToken !== currentSessToken) {
              return {
                status: 401,
                data: { detail: "SESSION_REPLACED" },
              };
            }
          }
        } catch {}
      }
    }
    return { status: 200, data: getActiveMockUser() };
  }

  if (normUrl === "/auth/logout") {
    return { status: 200, data: { success: true } };
  }

  // Website Builder & Public Website Config routes
  const DEFAULT_MOCK_WEBSITE_CONFIG = {
    site_name: "Taskosphere",
    site_tagline: "One platform for tasks, finance, compliance and people.",
    logo_url: "/logo.png",
    favicon_url: "/favicon.png",
    primary_color: "#0D3B66",
    accent_color: "#1FAF5A",
    surface_color: "#F7FAFC",
    hero_badge: "THE MODERN BUSINESS OPERATING SYSTEM",
    hero_title: "Everything your business needs. Nothing scattered.",
    hero_subtitle: "Task management, invoicing, accounting, HRMS, records, compliance and AI — connected in one intelligent workspace.",
    hero_cta_text: "Explore Taskosphere",
    hero_cta_href: "#features",
    hero_secondary_text: "Sign in",
    hero_secondary_href: "/login",
    hero_image_url: "/logo-transparent.png",
    features_title: "Everything your team needs. Nothing scattered.",
    features_subtitle: "Build the exact software package your customer needs and activate it through your commercial license.",
    features: [
      { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility.", icon: "check" },
      { title: "Invoicing", description: "Quotations, invoices, purchases and customer billing.", icon: "receipt" },
      { title: "Accounting", description: "Ledgers, banking, reports and financial controls.", icon: "landmark" },
      { title: "HRMS", description: "People, attendance, leave, payroll and recruitment.", icon: "users" },
      { title: "Compliance", description: "GST, ROC, trademark and compliance workflows.", icon: "shield" },
      { title: "Records", description: "Client records, documents, approvals and business information.", icon: "check" },
      { title: "AI & Automation", description: "Intelligent document processing and operational assistance.", icon: "sparkles" }
    ],
    solutions_title: "Tailored Solutions for Practice & Enterprise",
    solutions_subtitle: "Scalable tools designed to streamline high-volume statutory filing, taxation, and team management.",
    solutions: [
      {
        title: "Tax & Statutory Compliance",
        description: "Automated GST reconciliation, ROC tracking, and trademark monitoring with deadline reminders.",
        points: ["Auto-sync GST & MCA portals", "Bulk filing status tracker", "Intelligent compliance audit trails"],
      },
      {
        title: "Financials & Ledgers",
        description: "Integrated invoicing, accounting reports, and bank statement processing without switching apps.",
        points: ["Multi-branch invoicing", "Instant P&L and Balance Sheet", "Zero-touch reconciliation"],
      },
      {
        title: "Team & Practice Governance",
        description: "Granular role-based controls, client vaults, and task delegation with SLA tracking.",
        points: ["Role & permission matrix", "Client document vault", "Automated staff time & attendance"],
      },
    ],
    pricing_title: "Simple, transparent licensing",
    pricing_subtitle: "Choose the package that fits your organization.",
    pricing: [
      {
        name: "Professional",
        price: "₹4,999",
        period: "per month",
        description: "Essential tools for growing tax and accounting practices.",
        featured: false,
        cta: "Get Started",
      },
      {
        name: "Enterprise",
        price: "₹14,999",
        period: "per month",
        description: "Comprehensive suite with AI features, multi-company support, and custom modules.",
        featured: true,
        cta: "Contact Sales",
      },
      {
        name: "Platform Owner",
        price: "Custom",
        period: "annual",
        description: "Full white-label deployment with commercial console and unlimited tenant licensing.",
        featured: false,
        cta: "Inquire Now",
      },
    ],
    footer_company: "Taskosphere Technologies Pvt Ltd",
    footer_text: "A configurable commercial business operating system.",
    footer_copyright: "© 2026 Taskosphere. All rights reserved.",
    footer_email: "info.taskosphere@gmail.com",
    footer_phone: "+91 98765 43210",
    footer_address: "Mumbai, India",
    login_background_image: null,
    builder: {
      version: 5,
      activePageId: "home",
      pages: [{
        id: "home", name: "Home", slug: "/", visible: true,
        sections: [
          { id: "hero", type: "hero", title: "Hero", visible: true, layout: "split", data: {
            badge: "THE MODERN BUSINESS OPERATING SYSTEM",
            title: "Everything your business needs. Nothing scattered.",
            subtitle: "Task management, invoicing, accounting, HRMS, records, compliance and AI — connected in one intelligent workspace.",
            primaryText: "Explore Taskosphere", primaryHref: "#features",
            secondaryText: "Sign in", secondaryHref: "/login", image: "/logo-transparent.png",
            theme: "dark"
          } },
          { id: "features", type: "features", title: "Platform Modules", visible: true, layout: "cards", data: {
            heading: "One platform. Every business function.",
            subtitle: "Choose the exact software package your customer needs and activate it through your commercial license.",
            items: [
              { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility." },
              { title: "Invoicing", description: "Quotations, invoices, purchases and customer billing." },
              { title: "Accounting", description: "Ledgers, banking, reports and financial controls." },
              { title: "HRMS", description: "People, attendance, leave, payroll and recruitment." },
              { title: "Compliance", description: "GST, ROC, trademark and compliance workflows." },
              { title: "Records", description: "Client records, documents, approvals and business information." },
              { title: "AI & Automation", description: "Intelligent document processing and operational assistance." }
            ]
          } },
          { id: "why", type: "text", title: "Why Taskosphere", visible: true, data: {
            heading: "Run work from one connected workspace",
            body: "Assign and track work, communicate with your team, manage documents, monitor productivity and keep financial and compliance operations connected — without scattering information across different systems."
          } },
          { id: "cta", type: "cta", title: "Call to Action", visible: true, layout: "center", data: {
            heading: "Ready to build your Taskosphere workspace?", text: "Configure the modules your business needs and get started.", button: "Get started", href: "/login"
          } }
        ]
      }],
      global: {
        header: { sticky: true, showLogin: true, logo: true },
        footer: { show: true, text: "", social: true },
        design: { primary: "#0D3B66", accent: "#1FAF5A", background: "#FFFFFF", text: "#0F172A", font: "Inter", radius: "medium", width: "wide" }
      }
    }
  };

  const getStoredWebsiteConfig = () => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem("taskosphere_saved_website_config");
        if (raw) return JSON.parse(raw);
      }
    } catch {}
    return DEFAULT_MOCK_WEBSITE_CONFIG;
  };

  const syncBuilderToRoot = (cfg) => {
    const updated = { ...cfg };
    if (updated.builder && typeof updated.builder === "object") {
      const idt = updated.builder.global?.identity;
      if (idt) {
        if (idt.siteName) updated.site_name = idt.siteName;
        if (idt.tagline) updated.site_tagline = idt.tagline;
        if (idt.logoUrl) updated.logo_url = idt.logoUrl;
        if (idt.faviconUrl) updated.favicon_url = idt.faviconUrl;
      }
      const dsg = updated.builder.global?.design;
      if (dsg) {
        if (dsg.primary) updated.primary_color = dsg.primary;
        if (dsg.accent) updated.accent_color = dsg.accent;
      }
      const ft = updated.builder.global?.footer;
      if (ft) {
        if (ft.company) updated.footer_company = ft.company;
        if (ft.text) updated.footer_text = ft.text;
        if (ft.copyright) updated.footer_copyright = ft.copyright;
      }
      const firstPage = updated.builder.pages?.[0];
      const hero = firstPage?.sections?.find((s) => s.type === "hero");
      if (hero && hero.data) {
        if (hero.data.title) updated.hero_title = hero.data.title;
        if (hero.data.subtitle) updated.hero_subtitle = hero.data.subtitle;
        if (hero.data.badge) updated.hero_badge = hero.data.badge;
        if (hero.data.primaryText) updated.hero_cta_text = hero.data.primaryText;
        if (hero.data.primaryHref) updated.hero_cta_href = hero.data.primaryHref;
        if (hero.data.secondaryText) updated.hero_secondary_text = hero.data.secondaryText;
        if (hero.data.secondaryHref) updated.hero_secondary_href = hero.data.secondaryHref;
        if (hero.data.image) updated.hero_image_url = hero.data.image;
      }
    }
    return updated;
  };

  if (normUrl === "/website-config/public") {
    const data = getStoredWebsiteConfig();
    return { status: 200, data };
  }

  if (normUrl === "/website-config/admin") {
    const data = getStoredWebsiteConfig();
    return { status: 200, data };
  }

  if (normUrl === "/website-config" && method === "put") {
    const current = getStoredWebsiteConfig();
    const merged = syncBuilderToRoot({ ...current, ...requestData, updated_at: new Date().toISOString() });
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem("taskosphere_saved_website_config", JSON.stringify(merged));
        window.dispatchEvent(new CustomEvent("taskosphere:website-updated", { detail: merged }));
      }
    } catch {}
    return { status: 200, data: merged };
  }

  if (normUrl === "/website-config/reset" && method === "post") {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem("taskosphere_saved_website_config");
        window.dispatchEvent(new CustomEvent("taskosphere:website-updated", { detail: DEFAULT_MOCK_WEBSITE_CONFIG }));
      }
    } catch {}
    return { status: 200, data: DEFAULT_MOCK_WEBSITE_CONFIG };
  }

  if (normUrl.startsWith("/licensing")) {
    const licenses = getStoredMockLicenses();
    const customers = getStoredMockCustomers();
    const activeLic = licenses[0] || DEFAULT_MOCK_LICENSES[0];
    return {
      status: 200,
      data: {
        valid: true,
        status: "active",
        packages: [
          { id: "essential", code: "TSO-ESSENTIAL", name: "Taskosphere Essential", modules: ["taskosphere", "finix"], max_users: 10, max_installations: 1, validity_days: 365, price: 4999, active: true },
          { id: "professional", code: "TSO-PRO", name: "Taskosphere Professional", modules: ["taskosphere", "finix", "people_matrix"], max_users: 25, max_installations: 2, validity_days: 365, price: 9999, active: true },
          { id: "enterprise", code: "TSO-ENTERPRISE", name: "Taskosphere Enterprise", modules: ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix"], max_users: 100, max_installations: 5, validity_days: 365, price: 19999, active: true },
        ],
        licenses: licenses,
        customers: customers,
        license: {
          id: activeLic.id,
          plan: activeLic.package_name || "Custom",
          modules: activeLic.modules || ["taskosphere"],
          licensed_modules: activeLic.modules || ["taskosphere"],
          selected_features: activeLic.selected_features || {},
          max_users: activeLic.max_users || 100,
        },
      },
    };
  }

  if (normUrl.startsWith("/commercial-master-data/licenses")) {
    const parts = normUrl.split("/").filter(Boolean);
    const licenseId = parts[2] || "lic-01";
    const licenses = getStoredMockLicenses();
    if (method === "put") {
      const idx = licenses.findIndex((l) => l.id === licenseId);
      const incomingModules = data?.modules || (idx >= 0 ? licenses[idx].modules : ["taskosphere"]);
      const updated = {
        ...(idx >= 0 ? licenses[idx] : {}),
        id: licenseId,
        ...(data || {}),
        modules: incomingModules,
        licensed_modules: incomingModules,
        selected_features: data?.selected_features || (idx >= 0 ? licenses[idx].selected_features : {}),
        max_users: data?.max_users !== undefined ? Number(data.max_users) : (idx >= 0 ? licenses[idx].max_users : 100),
        max_installations: data?.max_installations !== undefined ? Number(data.max_installations) : (idx >= 0 ? licenses[idx].max_installations : 5),
        updated_at: new Date().toISOString(),
      };
      if (idx >= 0) licenses[idx] = updated;
      else licenses.push(updated);
      saveStoredMockLicenses(licenses);

      // Update customers
      const customers = getStoredMockCustomers();
      customers.forEach((c) => {
        if (c.id === updated.customer_id) {
          c.licensed_modules = updated.modules;
          c.selected_features = updated.selected_features;
        }
      });
      saveStoredMockCustomers(customers);

      // Synchronize MOCK_USER
      const perms = derivePermissionsFromModules(updated.modules);
      MOCK_USER.licensed_modules = updated.modules;
      MOCK_USER.selected_features = updated.selected_features;
      MOCK_USER.permissions = { ...MOCK_USER.permissions, ...perms };

      // Update current user in storage if matching
      if (typeof window !== "undefined" && window.localStorage) {
        try {
          const stored = window.localStorage.getItem("user") || window.sessionStorage.getItem("user");
          if (stored) {
            const parsed = JSON.parse(stored);
            parsed.licensed_modules = updated.modules;
            parsed.selected_features = updated.selected_features;
            parsed.permissions = { ...(parsed.permissions || {}), ...perms };
            window.localStorage.setItem("user", JSON.stringify(parsed));
          }
        } catch {}
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("license-updated", { detail: { license: updated } }));
        window.dispatchEvent(new CustomEvent("commercial-license-updated", { detail: { license: updated } }));
      }

      return { status: 200, data: updated };
    }
    const found = licenses.find((l) => l.id === licenseId) || licenses[0];
    return { status: 200, data: found || {} };
  }

  if (normUrl.startsWith("/commercial-master-data/customers")) {
    const parts = normUrl.split("/").filter(Boolean);
    const customerId = parts[2] || "cust-mda-01";
    const customers = getStoredMockCustomers();
    if (method === "put") {
      const idx = customers.findIndex((c) => c.id === customerId);
      const updated = {
        ...(idx >= 0 ? customers[idx] : {}),
        id: customerId,
        ...(data || {}),
        updated_at: new Date().toISOString(),
      };
      if (idx >= 0) customers[idx] = updated;
      else customers.push(updated);
      saveStoredMockCustomers(customers);
      return { status: 200, data: updated };
    }
    const found = customers.find((c) => c.id === customerId) || customers[0];
    return { status: 200, data: found || {} };
  }

  if (normUrl.startsWith("/commercial-onboarding/lookup")) {
    const compName = data?.company_name || "Manthan Desai And Associates";
    return {
      status: 200,
      data: {
        success: true,
        customer: {
          id: "cust-mda-01",
          company_name: compName,
          email: "director@desaiassociates.com",
          gstin: "27AAACD1234F1Z5",
          phone: "+91 98765 43210",
          address: "101, Business Center, Mumbai",
        },
        license: {
          id: "lic-01",
          license_key: data?.license_key || "TSO-COMM-2026-DEMO-0001",
          package_name: "Taskosphere Enterprise",
          valid_until: "2027-12-31T23:59:59Z",
          validity_months: 12,
        },
      },
    };
  }

  if (
    normUrl.startsWith("/commercial-onboarding/create-admin") ||
    normUrl.startsWith("/commercial-onboarding/create-user") ||
    normUrl.startsWith("/commercial-onboarding/create-staff")
  ) {
    const newUser = {
      ...MOCK_USER,
      email: data?.email || MOCK_USER.email,
      full_name: data?.full_name || MOCK_USER.full_name,
      company_name: data?.company_name || "Manthan Desai And Associates",
    };
    return {
      status: 200,
      data: {
        access_token: "mock-jwt-token-taskosphere",
        token: "mock-jwt-token-taskosphere",
        user: newUser,
      },
    };
  }

  if (normUrl.startsWith("/commercial-onboarding/module-catalog")) {
    return {
      status: 200,
      data: {
        modules: [
          { id: "TASKS", name: "Tasks & Workflows", active: true, monthly_price: 1999 },
          { id: "INVOICING", name: "Invoicing & Billing", active: true, monthly_price: 1499 },
          { id: "ACCOUNTING", name: "Accounting & Ledgers", active: true, monthly_price: 2499 },
          { id: "HRMS", name: "HRMS & Payroll", active: true, monthly_price: 1999 },
          { id: "COMPLIANCE", name: "Compliance & GST", active: true, monthly_price: 2999 },
        ],
      },
    };
  }

  if (normUrl.startsWith("/commercial-onboarding/my-company")) {
    return {
      status: 200,
      data: {
        company: {
          id: "comp-tasko-01",
          name: "Taskosphere Commercial Services",
          gstin: "27AAACD1234F1Z5",
          email: "admin@taskosphere.in",
          phone: "+91 98765 43210",
        },
        license: {
          id: "lic-01",
          package_name: "Taskosphere Enterprise",
          valid: true,
          status: "active",
        },
      },
    };
  }

  if (normUrl === "/tasks" || normUrl === "/tasks/") {
    if (method === "post") {
      const newTask = { ...data, id: `task-${Date.now()}`, _id: `task-${Date.now()}`, created_at: new Date().toISOString() };
      MOCK_TASKS.unshift(newTask);
      return { status: 201, data: newTask };
    }
    return { status: 200, data: MOCK_TASKS };
  }

  if (normUrl.startsWith("/clients") || normUrl.startsWith("/client-portal/all-clients")) {
    if (method === "post") {
      const newClient = { ...data, id: `cli-${Date.now()}`, _id: `cli-${Date.now()}` };
      MOCK_CLIENTS.unshift(newClient);
      return { status: 201, data: newClient };
    }
    return { status: 200, data: MOCK_CLIENTS };
  }

  if (normUrl.startsWith("/companies")) {
    return {
      status: 200,
      data: [
        {
          id: "comp-tasko-01",
          name: "Taskosphere Commercial Services",
          status: "active",
        },
      ],
    };
  }

  if (normUrl.startsWith("/invoices") || normUrl.startsWith("/sales-invoices")) {
    return { status: 200, data: MOCK_INVOICES };
  }

  if (normUrl.startsWith("/compliance")) {
    return { status: 200, data: MOCK_COMPLIANCE };
  }

  if (normUrl.startsWith("/commercial-master-data/platform-users")) {
    if (!globalThis.__mockPlatformUsers) {
      globalThis.__mockPlatformUsers = [
        {
          id: "lic-usr-01",
          email: "director@desaiassociates.com",
          full_name: "Manthan P Desai",
          role: "admin",
          status: "active",
          is_active: true,
          phone: "+91 98765 43210",
          designation: "Managing Partner",
          employee_code: "MDA-001",
          department_id: "ROC",
          departments: ["ROC", "IT", "GST"],
          company_id: "cust-mda-01",
          commercial_customer_id: "cust-mda-01",
          created_at: new Date().toISOString(),
        },
        {
          id: "lic-usr-02",
          email: "compliance@desaiassociates.com",
          full_name: "Sneha Patel",
          role: "staff",
          status: "active",
          is_active: true,
          phone: "+91 98765 43211",
          designation: "Compliance Executive",
          employee_code: "MDA-002",
          department_id: "GST",
          departments: ["GST", "TDS"],
          company_id: "cust-mda-01",
          commercial_customer_id: "cust-mda-01",
          created_at: new Date().toISOString(),
        },
      ];
    }
    const users = globalThis.__mockPlatformUsers;
    const parts = normUrl.split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];

    if (method === "delete" || (method === "post" && lastPart === "delete")) {
      const targetId = lastPart === "delete" ? secondLast : lastPart;
      const idx = users.findIndex(u => u.id === targetId);
      if (idx !== -1) users.splice(idx, 1);
      return { status: 200, data: { success: true, message: "User deleted" } };
    }

    if (method === "post" && (lastPart === "activate" || lastPart === "deactivate")) {
      const u = users.find(x => x.id === secondLast);
      if (u) {
        u.status = lastPart === "activate" ? "active" : "inactive";
        u.is_active = lastPart === "activate";
      }
      return { status: 200, data: { success: true, user: u } };
    }

    if (method === "put") {
      const targetId = lastPart;
      const u = users.find(x => x.id === targetId);
      if (u) {
        Object.assign(u, data);
        return { status: 200, data: u };
      }
      return { status: 404, data: { detail: "User not found" } };
    }

    if (method === "post") {
      const newUser = {
        id: `lic-usr-${Date.now()}`,
        status: "active",
        is_active: true,
        departments: [],
        ...data,
        created_at: new Date().toISOString(),
      };
      users.unshift(newUser);
      return { status: 201, data: newUser };
    }

    const activeLic = getStoredMockLicenses().find((l) => l.id === "lic-01" || l.customer_id === "cust-mda-01") || getStoredMockLicenses()[0];
    const userPerms = derivePermissionsFromModules(activeLic.modules);
    const hydratedUsers = users.map((u) => ({
      ...u,
      licensed_modules: activeLic.modules,
      selected_features: activeLic.selected_features,
      permissions: {
        ...(u.permissions || {}),
        ...userPerms,
      },
    }));
    return {
      status: 200,
      data: {
        users: hydratedUsers,
        company: { id: "cust-mda-01", name: "Manthan Desai And Associates" },
        license: activeLic,
        platform_owner: true,
      },
    };
  }

  if (normUrl.startsWith("/commercial-master-data/users")) {
    return {
      status: 200,
      data: {
        users: [
          MOCK_USER,
          {
            id: "usr-02",
            email: "rohan@taskosphere.in",
            full_name: "Rohan Verma",
            role: "Associate",
            status: "active",
            is_active: true,
          },
          {
            id: "usr-03",
            email: "priya@taskosphere.in",
            full_name: "Priya Sharma",
            role: "Manager",
            status: "active",
            is_active: true,
          },
        ],
        company: { id: "comp-tasko-01", name: "Taskosphere Platform Operational" },
        license: { id: "lic-owner", max_users: 999, modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE"] },
        platform_owner: true,
      },
    };
  }

  if (normUrl.startsWith("/users")) {
    return {
      status: 200,
      data: [
        MOCK_USER,
        {
          id: "usr-02",
          email: "rohan@taskosphere.in",
          full_name: "Rohan Verma",
          role: "Associate",
        },
        {
          id: "usr-03",
          email: "priya@taskosphere.in",
          full_name: "Priya Sharma",
          role: "Manager",
        },
      ],
    };
  }

  // Generic fallback for any other GET/POST
  if (method === "get") {
    return { status: 200, data: [] };
  }
  return { status: 200, data: { success: true, message: "OK" } };
}
