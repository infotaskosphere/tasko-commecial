/**
 * mockBackend.js
 * In-memory mock response provider for Taskosphere Commercial
 * Allows full offline / preview functionality without requiring an external MongoDB/Python instance.
 */

export const MOCK_USER = {
  id: "usr-admin-01",
  email: "info.taskosphere@gmail.com",
  full_name: "Taskosphere Administrator",
  role: "admin",
  company_id: "comp-tasko-01",
  company: {
    id: "comp-tasko-01",
    name: "Taskosphere Commercial Services",
    plan: "Enterprise",
  },
  subscription: {
    status: "active",
    package_id: "enterprise",
    valid_until: "2030-12-31T23:59:59Z",
  },
  permissions: {
    can_access_taskosphere: true,
    can_access_finix: true,
    can_access_compliance: true,
    can_access_records: true,
    can_access_proposals: true,
    can_access_people_matrix: true,
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

  if (normUrl === "/auth/login" || normUrl === "/auth/signin") {
    return {
      status: 200,
      data: {
        access_token: "mock-jwt-token-taskosphere",
        token: "mock-jwt-token-taskosphere",
        user: MOCK_USER,
      },
    };
  }

  if (normUrl === "/auth/me") {
    return { status: 200, data: MOCK_USER };
  }

  if (normUrl === "/auth/logout") {
    return { status: 200, data: { success: true } };
  }

  if (normUrl === "/website-config/public") {
    return {
      status: 200,
      data: {
        site_name: "Taskosphere",
        logo_url: "/logo.png",
        primary_color: "#0D3B66",
        accent_color: "#1FAF5A",
        login_background_image: null,
      },
    };
  }

  if (normUrl === "/website-config/admin") {
    return {
      status: 200,
      data: {
        site_name: "Taskosphere",
        logo_url: "/logo.png",
        primary_color: "#0D3B66",
        accent_color: "#1FAF5A",
      },
    };
  }

  if (normUrl.startsWith("/licensing")) {
    return {
      status: 200,
      data: {
        valid: true,
        status: "active",
        license: {
          plan: "Enterprise",
          modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE"],
          max_users: 100,
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

    return {
      status: 200,
      data: {
        users: [...users],
        company: { id: "cust-mda-01", name: "Manthan Desai And Associates" },
        license: { id: "lic-01", max_users: 10, modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE"] },
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
