import React, { useEffect, useState } from "react";
import WebsiteRenderer, { DEFAULT_BUILDER } from "@/components/website/WebsiteRenderer";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";

const STORAGE_KEY = "taskosphere_saved_website_config";

const rebrandPublicText = (value) => typeof value === "string"
  ? value
    .replace(/\btaskosphere\b/gi, "Task Management")
    .replace(/\bonenexa\b/gi, "ONENEXA")
    .replace(/\/onenexa-logo\.svg/gi, "/onenexa-logo.png")
  : value;

const rebrandBuilder = (value) => {
  if (Array.isArray(value)) return value.map(rebrandBuilder);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebrandBuilder(item)]));
  return rebrandPublicText(value);
};

const identityFromConfig = (config = {}) => ({
  site_name: rebrandPublicText(config.site_name) || "ONENEXA",
  site_tagline: rebrandPublicText(config.site_tagline) || "One platform for modern business operations.",
  logo_url: rebrandPublicText(config.logo_url) || "/onenexa-logo.png",
  favicon_url: rebrandPublicText(config.favicon_url) || "/onenexa-logo.png",
  footer_company: rebrandPublicText(config.footer_company) || "ONENEXA",
  footer_text: rebrandPublicText(config.footer_text),
  footer_copyright: rebrandPublicText(config.footer_copyright) || "© 2026 ONENEXA. All rights reserved.",
});

const normalizeBuilder = (savedBuilder) => {
  const branded = rebrandBuilder(savedBuilder || {});
  return {
    ...DEFAULT_BUILDER,
    ...branded,
    global: {
      ...DEFAULT_BUILDER.global,
      ...branded.global,
      design: { ...DEFAULT_BUILDER.global.design, ...branded.global?.design },
      header: { ...DEFAULT_BUILDER.global.header, ...branded.global?.header },
      footer: { ...DEFAULT_BUILDER.global.footer, ...branded.global?.footer },
    },
    pages: branded.pages || DEFAULT_BUILDER.pages,
  };
};

const getCachedConfig = () => {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const cached = window.localStorage.getItem(STORAGE_KEY);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
};

const getCachedBuilder = () => {
  const cached = getCachedConfig();
  return cached?.builder?.pages?.length ? normalizeBuilder(cached.builder) : null;
};

export default function WebsiteHome() {
  // Use the last successfully saved website immediately. This prevents the
  // default builder from being painted first and then replaced by the saved
  // design after the public config request completes.
  const cachedConfig = getCachedConfig();
  const cachedBuilder = cachedConfig?.builder?.pages?.length ? normalizeBuilder(cachedConfig.builder) : null;
  const [builder, setBuilder] = useState(() => cachedBuilder);
  const [identity, setIdentity] = useState(() => cachedConfig ? identityFromConfig(cachedConfig) : {});
  const [ready, setReady] = useState(() => Boolean(cachedBuilder));

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const saved = await getPublicWebsiteConfig();
      if (!alive) return;

      if (saved?.builder?.pages?.length) {
        setBuilder(normalizeBuilder(saved.builder));
        setIdentity(identityFromConfig(saved));
      } else if (!builder) {
        // Only use the code default when there is genuinely no saved website
        // configuration. It is deliberately never painted before the API/cache
        // lookup completes.
        setBuilder(DEFAULT_BUILDER);
        if (saved) setIdentity(identityFromConfig(saved));
      }

      setReady(true);
    };

    load();
    const onUpdate = (event) => {
      const saved = event.detail;
      if (!saved) return;
      if (saved.builder?.pages?.length) setBuilder(normalizeBuilder(saved.builder));
      setIdentity(identityFromConfig(saved));
      setReady(true);
    };
    window.addEventListener("taskosphere:website-updated", onUpdate);
    return () => {
      alive = false;
      window.removeEventListener("taskosphere:website-updated", onUpdate);
    };
  }, []);

  useEffect(() => {
    document.title = identity.site_name || "ONENEXA";
    if (identity.favicon_url) {
      const link = document.querySelector('link[rel="icon"]') || document.createElement("link");
      link.rel = "icon";
      link.href = identity.favicon_url;
      document.head.appendChild(link);
    }
  }, [identity]);

  if (!ready || !builder) {
    return (
      <div className="min-h-screen bg-white text-slate-900" aria-label="Loading ONENEXA">
        <header className="h-[72px] border-b border-slate-200 bg-white" />
        <main className="min-h-[calc(100vh-72px)] bg-slate-50" />
      </div>
    );
  }

  return <WebsiteRenderer builder={builder} identity={identity} />;
}
