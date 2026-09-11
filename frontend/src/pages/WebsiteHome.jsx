import React, { useEffect, useState } from "react";
import WebsiteRenderer, { DEFAULT_BUILDER } from "@/components/website/WebsiteRenderer";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";

const identityFromConfig = (config = {}) => ({
  site_name: config.site_name,
  site_tagline: config.site_tagline,
  logo_url: config.logo_url,
  favicon_url: config.favicon_url,
  footer_company: config.footer_company,
  footer_text: config.footer_text,
  footer_copyright: config.footer_copyright,
});

export default function WebsiteHome() {
  const [builder, setBuilder] = useState(DEFAULT_BUILDER);
  const [identity, setIdentity] = useState({});

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const saved = await getPublicWebsiteConfig();
      if (!alive || !saved) return;
      if (saved.builder?.pages?.length) {
        setBuilder({
          ...DEFAULT_BUILDER,
          ...saved.builder,
          global: {
            ...DEFAULT_BUILDER.global,
            ...saved.builder.global,
            design: { ...DEFAULT_BUILDER.global.design, ...saved.builder.global?.design },
            header: { ...DEFAULT_BUILDER.global.header, ...saved.builder.global?.header },
            footer: { ...DEFAULT_BUILDER.global.footer, ...saved.builder.global?.footer },
          },
          pages: saved.builder.pages,
        });
      }
      setIdentity(identityFromConfig(saved));
    };
    load();
    const onUpdate = (event) => {
      const saved = event.detail;
      if (!saved) return;
      if (saved.builder?.pages?.length) setBuilder(saved.builder);
      setIdentity(identityFromConfig(saved));
    };
    window.addEventListener("taskosphere:website-updated", onUpdate);
    return () => { alive = false; window.removeEventListener("taskosphere:website-updated", onUpdate); };
  }, []);

  useEffect(() => {
    document.title = identity.site_name || "Taskosphere";
    if (identity.favicon_url) {
      const link = document.querySelector('link[rel="icon"]') || document.createElement("link");
      link.rel = "icon"; link.href = identity.favicon_url; document.head.appendChild(link);
    }
  }, [identity]);

  return <WebsiteRenderer builder={builder} identity={identity} />;
}
