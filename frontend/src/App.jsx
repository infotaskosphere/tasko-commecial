import React, { Suspense, memo, useEffect } from "react";
import { BrowserRouter, NavLink, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { Toaster } from "@/components/ui/sonner";
import AppRoutes from "./AppRoutes.jsx";
import { useLoading } from "./lib/api";
import GifLoader from "@/components/ui/GifLoader.jsx";
import ReminderPopupManager from "@/components/layout/ReminderPopupManager.jsx";
import { BulkWASenderProvider } from "@/contexts/BulkWASenderContext";
import BulkWASenderWidget from "@/contexts/BulkWASenderWidget";
import { MinimizedFormsProvider } from "@/contexts/MinimizedFormsContext";
import MinimizedFormsDock from "@/components/layout/MinimizedFormsDock.jsx";
import { DocumentUploadProvider } from "@/contexts/DocumentUploadContext.jsx";
import "./commercial-business-ui.css";

const PLATFORM_OWNER_EMAIL = "info.taskosphere@gmail.com";

const BottomLoadingBar = memo(function BottomLoadingBar() {
  const loading = useLoading();
  if (!loading) return null;
  return <div className="taskosphere-loading-bar" style={{ position: "fixed", bottom: 0, left: 0, width: "30%", height: 3, background: "linear-gradient(90deg, #7F77DD, #1F6FB2)", zIndex: 9999, pointerEvents: "none" }} />;
});

const ROUTE_PREFETCHERS = {
  "/dashboard": () => import("./pages/Dashboard.jsx"),
  "/tasks": () => import("./pages/Tasks.jsx"),
  "/todos": () => import("./pages/TodoDashboard.jsx"),
  "/attendance": () => import("./pages/Attendance.jsx"),
  "/reminders": () => import("./pages/Reminders.jsx"),
  "/action-center": () => import("./pages/ActionCenter.jsx"),
  "/compliance-dashboard": () => import("./pages/ComplianceDashboard.jsx"),
  "/compliance": () => import("./pages/CompliancePage.jsx"),
  "/gst-reconciliation": () => import("./pages/GSTReconciliation.jsx"),
  "/trademark-sphere": () => import("./pages/TrademarkSphere.jsx"),
  "/roc-sphere": () => import("./pages/ROCSpherePage.jsx"),
  "/records-dashboard": () => import("./pages/RecordsDashboard.jsx"),
  "/clients": () => import("./pages/Clients.jsx"),
  "/client-proposals-dashboard": () => import("./pages/ClientProposalsDashboard.jsx"),
  "/leads": () => import("./pages/Leads.jsx"),
  "/quotations": () => import("./pages/Quotations.jsx"),
  "/finix-dashboard": () => import("./pages/FinixDashboard.jsx"),
  "/invoicing": () => import("./pages/Invoicing.jsx"),
  "/bank-accounts": () => import("./pages/BankAccounts.jsx"),
  "/accounting-reports": () => import("./pages/AccountingReports.jsx"),
  "/people-matrix": () => import("./pages/PeopleMatrixDashboard.jsx"),
  "/reports": () => import("./pages/Reports.jsx"),
  "/users": () => import("./pages/Users.jsx"),
  "/master-console": () => import("./pages/MasterConsole.jsx"),
  "/activate-license": () => import("./pages/LicenseActivation.jsx"),
};

const prefetchedRoutes = new Set();
function prefetchRoute(path) {
  if (prefetchedRoutes.has(path)) return;
  const loader = ROUTE_PREFETCHERS[path];
  if (!loader) return;
  prefetchedRoutes.add(path);
  loader().catch(() => prefetchedRoutes.delete(path));
}

function RoutePrefetcher() {
  useEffect(() => {
    const warm = (event) => {
      const target = event.target?.closest?.("a[href]");
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href || !href.startsWith("/")) return;
      prefetchRoute(href.split("?")[0].split("#")[0]);
    };
    document.addEventListener("pointerover", warm, { passive: true });
    document.addEventListener("focusin", warm);
    return () => {
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("focusin", warm);
    };
  }, []);
  return null;
}

const BUSINESS_PAGE_TITLES = {
  "/tasks": "Tasks",
  "/todos": "To Do",
  "/attendance": "Attendance",
  "/reminders": "Reminders",
  "/action-center": "Action Center",
  "/visits": "Client Visits",
  "/ai-reader": "AI Document Reader",
  "/compliance": "Compliance Tracker",
  "/gst-reconciliation": "GST Reconciliation",
  "/trademark-sphere": "Trademark Sphere",
  "/roc-sphere": "ROC Sphere",
  "/mis-report": "MIS Report",
  "/salary-slips": "Salary Slip Generator",
  "/records-dashboard": "Records Dashboard",
  "/client-approvals": "Client Approvals",
  "/dsc": "DSC Register",
  "/documents": "Document Register",
  "/clients": "Clients",
  "/passwords": "Password Vault",
  "/client-proposals-dashboard": "Client Proposals",
  "/leads": "Lead Management",
  "/quotations": "Quotations",
  "/finix-dashboard": "Finix",
  "/invoicing": "Sales & Invoicing",
  "/purchase": "Purchase",
  "/bank-accounts": "Bank Accounts",
  "/chart-of-accounts": "Chart of Accounts",
  "/journal-entries": "Journal Entries",
  "/accounting-reports": "Accounting Reports",
  "/people-matrix": "People Matrix",
  "/users": "Users",
  "/leave": "Leave",
  "/payroll": "Payroll",
  "/hr": "Human Resources",
  "/recruitment": "Recruitment",
  "/reports": "Reports",
  "/settings/general": "General Settings",
  "/settings/email": "Email Accounts",
  "/settings/whatsapp": "Message Automation",
  "/admin-dashboard": "Admin Dashboard",
  "/permission-matrix": "Permission Matrix",
  "/master-data": "Master Data",
  "/roles": "Roles & Access",
  "/contact-details": "Contact Details",
  "/master-console": "Commercial Console",
};

const BUSINESS_LANDING_PATHS = new Set([
  "/dashboard",
  "/finix-dashboard",
  "/compliance-dashboard",
  "/records-dashboard",
  "/client-proposals-dashboard",
  "/people-matrix",
  "/admin-dashboard",
  "/master-console",
]);

function BusinessPageDesignScope() {
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname;
    const title = BUSINESS_PAGE_TITLES[path]
      || Object.entries(BUSINESS_PAGE_TITLES).sort((a, b) => b[0].length - a[0].length).find(([prefix]) => path.startsWith(`${prefix}/`))?.[1]
      || path.split("/").filter(Boolean).pop()?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      || "Business Workspace";

    document.documentElement.style.setProperty("--business-page-title", JSON.stringify(title));
    document.body.classList.toggle("biz-dashboard-home", BUSINESS_LANDING_PATHS.has(path));
    document.body.classList.toggle("biz-section-landing", /^(\/finix-dashboard|\/compliance-dashboard|\/records-dashboard|\/client-proposals-dashboard|\/people-matrix)$/.test(path));
    document.body.classList.toggle("biz-master-console", path === "/master-console");

    return () => {
      document.body.classList.remove("biz-dashboard-home", "biz-section-landing", "biz-master-console");
    };
  }, [location.pathname]);

  return null;
}

function WebsiteSurfaceScope() {
  const location = useLocation();
  useEffect(() => {
    const isWebsite = location.pathname === "/" || location.pathname === "/website";
    const isBuilder = location.pathname.startsWith("/master-console/website");
    document.body.classList.toggle("website-surface", isWebsite || isBuilder);
    document.body.classList.toggle("website-builder-surface", isBuilder);
    return () => document.body.classList.remove("website-surface", "website-builder-surface");
  }, [location.pathname]);
  return null;
}

function CommercialConsoleShortcut() {
  const { user } = useAuth();
  const isPlatformOwner = String(user?.email || "").trim().toLowerCase() === PLATFORM_OWNER_EMAIL;
  if (!isPlatformOwner) return null;

  const items = [
    { path: "/master-console", label: "Commercial Console", icon: "▦" },
    { path: "/master-console/website", label: "Website Studio", icon: "◫" },
  ];

  return (
    <div
      data-commercial-console="true"
      aria-label="Platform Owner tools"
      className="commercial-sidebar-tools hidden lg:flex flex-col"
    >
      {items.map(({ path, label, icon }) => (
        <NavLink
          key={path}
          to={path}
          title={label}
          className={({ isActive }) => `commercial-sidebar-tool group relative flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors duration-150 ${
            isActive
              ? "bg-white/[0.09] text-white"
              : "text-slate-300 hover:bg-white/[0.07] hover:text-white"
          }`}
        >
          <span className="commercial-sidebar-tool-icon flex h-5 w-5 flex-shrink-0 items-center justify-center text-[14px] leading-none">
            {icon}
          </span>
          <span className="commercial-sidebar-tool-label whitespace-nowrap tracking-tight">
            {label}
          </span>
          <span className="commercial-sidebar-tool-tooltip pointer-events-none absolute left-full ml-3 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-lg transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100">
            {label}
          </span>
        </NavLink>
      ))}
      <style>{`
        /* Platform-owner tools sit directly above the native Collapse Sidebar
           control, giving all three footer controls the same size and rhythm. */
        .commercial-sidebar-tools {
          position: fixed !important;
          left: 0 !important;
          top: calc(100vh - 76px - 88px) !important;
          bottom: auto !important;
          width: 280px !important;
          height: 88px !important;
          padding: 0 16px !important;
          margin: 0 !important;
          gap: 0 !important;
          z-index: 44 !important;
          background: #0D3B66 !important;
          border-right: 1px solid rgba(255,255,255,0.08) !important;
          box-sizing: border-box !important;
        }
        .commercial-sidebar-tools .commercial-sidebar-tool {
          flex: 0 0 44px !important;
          width: 100% !important;
          height: 44px !important;
          min-height: 44px !important;
          max-height: 44px !important;
          padding: 0 12px !important;
          margin: 0 !important;
          box-sizing: border-box !important;
          border-radius: 12px !important;
        }
        .commercial-sidebar-tools .commercial-sidebar-tool-icon {
          color: #94a3b8 !important;
        }
        .commercial-sidebar-tools .commercial-sidebar-tool:hover .commercial-sidebar-tool-icon,
        .commercial-sidebar-tools .commercial-sidebar-tool[aria-current="page"] .commercial-sidebar-tool-icon {
          color: #f8fafc !important;
        }
        .commercial-sidebar-tools .commercial-sidebar-tool-tooltip {
          transform: translateX(4px);
        }
        body:has(aside[style*="width: 80px"]) .commercial-sidebar-tools {
          width: 80px !important;
          padding-left: 16px !important;
          padding-right: 16px !important;
        }
        body:has(aside[style*="width: 80px"]) .commercial-sidebar-tools .commercial-sidebar-tool {
          justify-content: center !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
        }
        body:has(aside[style*="width: 80px"]) .commercial-sidebar-tool-label {
          display: none !important;
        }
        body:has(aside[style*="width: 80px"]) .commercial-sidebar-tool-tooltip {
          left: 100% !important;
        }
      `}</style>
    </div>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000, gcTime: 10 * 60 * 1000, retry: 1, refetchOnWindowFocus: false, refetchOnReconnect: false } } });

export default function App() {
  return <QueryClientProvider client={queryClient}><AuthProvider><BrowserRouter><WebsiteSurfaceScope /><BusinessPageDesignScope /><MinimizedFormsProvider><BulkWASenderProvider><DocumentUploadProvider><BottomLoadingBar /><RoutePrefetcher /><CommercialConsoleShortcut /><ReminderPopupManager /><BulkWASenderWidget /><MinimizedFormsDock /><Suspense fallback={<GifLoader />}><AppRoutes /></Suspense><Toaster position="top-right" richColors /></DocumentUploadProvider></BulkWASenderProvider></MinimizedFormsProvider></BrowserRouter></AuthProvider></QueryClientProvider>;
}