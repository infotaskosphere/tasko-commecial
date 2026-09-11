import React, { useEffect, useState } from "react";
import WebsiteRenderer, { DEFAULT_BUILDER } from "@/components/website/WebsiteRenderer";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";

const STORAGE_KEY = "taskosphere_saved_website_config";

const identityFromConfig = (config = {}) => ({
  site_name: config.site_name,
  site_tagline: config.site_tagline,
  logo_url: config.logo_url,
  favicon_url: config.favicon_url,
  footer_company: config.footer_company,
  footer_text: config.footer_text,
  footer_copyright: config.footer_copyright,
});

const normalizeBuilder = (savedBuilder) => ({
  ...DEFAULT_BUILDER,
  ...savedBuilder,
  global: {
    ...DEFAULT_BUILDER.global,
    ...savedBuilder?.global,
    design: { ...DEFAULT_BUILDER.global.design, ...savedBuilder?.global?.design },
    header: { ...DEFAULT_BUILDER.global.header, ...savedBuilder?.global?.header },
    footer: { ...DEFAULT_BUILDER.global.footer, ...savedBuilder?.global?.footer },
  },
  pages: savedBuilder?.pages,
});

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
    document.title = identity.site_name || "Taskosphere";
    if (identity.favicon_url) {
      const link = document.querySelector('link[rel="icon"]') || document.createElement("link");
      link.rel = "icon";
      link.href = identity.favicon_url;
      document.head.appendChild(link);
    }
  }, [identity]);

  if (!ready || !builder) {
    return (
      <div className="min-h-screen bg-white text-slate-900" aria-label="Loading Taskosphere">
        <header className="h-[72px] border-b border-slate-200 bg-white" />
        <main className="min-h-[calc(100vh-72px)] bg-slate-50" />
      </div>
    );
  }

  return <WebsiteRenderer builder={builder} identity={identity} />;
}
