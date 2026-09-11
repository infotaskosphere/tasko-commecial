import React from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Navigate } from "react-router-dom";
import GifLoader from "@/components/ui/GifLoader.jsx";

/**
 * RoleGuard — wrap any page that requires a specific permission.
 * Platform owners bypass all permission checks. Commercial licensee admins
 * are admins inside their tenant, but their access is still capped by the
 * active commercial license permissions hydrated by AuthContext.
 */
const RoleGuard = ({ children, permission }) => {
  const { user, loading, hasPermission, isPlatformOwner } = useAuth();

  if (loading) return <GifLoader />;
  if (!user) return <Navigate to="/login" replace />;

  if (!permission || isPlatformOwner) return <>{children}</>;

  const perms = Array.isArray(permission) ? permission : [permission];
  const hasAccess = perms.some((p) => hasPermission(p));
  if (!hasAccess) return <Navigate to="/dashboard" replace />;

  return <>{children}</>;
};

export default RoleGuard;
