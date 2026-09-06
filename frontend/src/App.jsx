import React, { Suspense, memo, useEffect } from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/AuthContext";
import { Toaster } from "@/components/ui/sonner";
import AppRoutes from "./AppRoutes.jsx";
import { useLoading } from "./lib/api";
import GifLoader from "@/components/ui/GifLoader.jsx";
import ReminderPopupManager from "@/components/layout/ReminderPopupManager.jsx";
import { BulkWASenderProvider } from "@/components/BulkWASenderContext";
import BulkWASenderWidget from "@/contexts/BulkWASenderWidget";
import { MinimizedFormsProvider } from "@/contexts/MinimizedFormsContext";
import MinimizedFormsDock from "@/components/layout/MinimizedFormsDock.jsx";
import { DocumentUploadProvider } from "@/contexts/DocumentUploadContext.jsx";

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

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000, gcTime: 10 * 60 * 1000, retry: 1, refetchOnWindowFocus: false, refetchOnReconnect: false } } });

export default function App() {
  return <QueryClientProvider client={queryClient}><AuthProvider><BrowserRouter><MinimizedFormsProvider><BulkWASenderProvider><DocumentUploadProvider><BottomLoadingBar /><RoutePrefetcher /><ReminderPopupManager /><BulkWASenderWidget /><MinimizedFormsDock /><Suspense fallback={<GifLoader />}><AppRoutes /></Suspense><Toaster position="top-right" richColors /></DocumentUploadProvider></BulkWASenderProvider></MinimizedFormsProvider></BrowserRouter></AuthProvider></QueryClientProvider>;
}
