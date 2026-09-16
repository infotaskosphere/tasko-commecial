import React, { Suspense, memo, useEffect } from "react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/AuthContext";
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
import "./email-google-oauth.css";
import "./module-branding.css";
import "./taskosphere-header-colors.css";


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