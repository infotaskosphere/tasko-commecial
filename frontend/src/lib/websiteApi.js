import api from "./api";

const STORAGE_KEY = "taskosphere_saved_website_config";

export async function getPublicWebsiteConfig() {
  try {
    const response = await api.get("/website-config/public", { _silent: true, _skipReadyGate: true });
    if (response?.data) {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(response.data));
      }
      return response.data;
    }
  } catch (err) {
    console.warn("Public config fetch fallback to localStorage:", err);
  }

  if (typeof window !== "undefined" && window.localStorage) {
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }
  }
  return null;
}

export async function getAdminWebsiteConfig() {
  try {
    const response = await api.get("/website-config/admin");
    if (response?.data) {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(response.data));
      }
      return response.data;
    }
  } catch (err) {
    console.warn("Admin config fetch fallback to localStorage:", err);
  }

  if (typeof window !== "undefined" && window.localStorage) {
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }
  }
  return null;
}

export async function saveWebsiteConfig(config) {
  let savedData = config;
  try {
    const response = await api.put("/website-config", config);
    if (response?.data) {
      savedData = response.data;
    }
  } catch (err) {
    console.warn("Save API failed or offline, saving to localStorage:", err);
  }

  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData));
    window.dispatchEvent(new CustomEvent("taskosphere:website-updated", { detail: savedData }));
  }
  return savedData;
}

export async function resetWebsiteConfig() {
  let defaultData = null;
  try {
    const response = await api.post("/website-config/reset");
    if (response?.data) defaultData = response.data;
  } catch (err) {
    console.warn("Reset API error, clearing local cache:", err);
  }

  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent("taskosphere:website-updated", { detail: defaultData }));
  }
  return defaultData;
}

/**
 * Download website config as a single JSON file (uncompressed, not zipped)
 */
export function downloadWebsiteConfigJSON(config, filename = "website-config.json") {
  const jsonStr = JSON.stringify(config, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download website as a single self-contained HTML file (uncompressed, not zipped)
 */
export function downloadWebsiteHTML(config, filename = "website-export.html") {
  const siteName = config.site_name || "Taskosphere";
  const heroTitle = config.hero_title || config.builder?.pages?.[0]?.sections?.find(s => s.type === "hero")?.data?.title || "Run your entire business from one workspace";
  const heroSubtitle = config.hero_subtitle || config.builder?.pages?.[0]?.sections?.find(s => s.type === "hero")?.data?.subtitle || "";
  const primaryColor = config.primary_color || config.builder?.global?.design?.primary || "#0D3B66";
  const accentColor = config.accent_color || config.builder?.global?.design?.accent || "#1FAF5A";
  const features = config.features || [];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${siteName} — ${config.site_tagline || "Business Operating System"}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
  </style>
</head>
<body class="bg-slate-50 text-slate-900 antialiased">
  <header class="sticky top-0 z-50 bg-white/95 backdrop-blur border-b border-slate-200">
    <div class="max-w-7xl mx-auto px-6 h-18 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-xl font-black text-slate-900 tracking-tight">${siteName}</span>
      </div>
      <nav class="hidden md:flex items-center gap-8 text-sm font-semibold text-slate-600">
        <a href="#features" class="hover:text-slate-900 transition">Features</a>
        <a href="#solutions" class="hover:text-slate-900 transition">Solutions</a>
        <a href="#pricing" class="hover:text-slate-900 transition">Pricing</a>
      </nav>
      <div class="flex items-center gap-3">
        <a href="/login" class="px-5 py-2.5 rounded-xl font-bold text-sm text-white shadow-sm" style="background: ${primaryColor}">Sign In</a>
      </div>
    </div>
  </header>

  <main>
    <section class="relative overflow-hidden py-24 text-white" style="background: linear-gradient(135deg, ${primaryColor} 0%, #102A43 58%, #061827 100%)">
      <div class="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <span class="inline-block px-3.5 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider bg-white/10 text-white/90 border border-white/15 mb-6">${config.hero_badge || "BUSINESS OPERATING SYSTEM"}</span>
          <h1 class="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tight leading-tight">${heroTitle}</h1>
          <p class="mt-6 text-lg text-white/75 leading-relaxed max-w-xl">${heroSubtitle}</p>
          <div class="mt-8 flex flex-wrap gap-4">
            <a href="#features" class="px-6 py-3.5 rounded-xl font-bold text-sm text-white shadow-lg" style="background: ${accentColor}">${config.hero_cta_text || "Explore Platform"}</a>
            <a href="/login" class="px-6 py-3.5 rounded-xl font-bold text-sm text-white border border-white/20 bg-white/10 hover:bg-white/15 transition">${config.hero_secondary_text || "Sign in"}</a>
          </div>
        </div>
        <div class="rounded-3xl border border-white/10 bg-white/10 p-4 shadow-2xl backdrop-blur-xl">
          <div class="flex min-h-[300px] items-center justify-center rounded-2xl bg-white/5 p-8">
            <img src="${config.logo_url || config.hero_image_url || '/logo-transparent.png'}" alt="${siteName}" class="max-h-56 max-w-full object-contain">
          </div>
        </div>
      </div>
    </section>

    <section id="features" class="py-24 px-6 max-w-7xl mx-auto">
      <div class="text-center max-w-3xl mx-auto mb-16">
        <h2 class="text-3xl sm:text-4xl font-black text-slate-900">${config.features_title || "Platform Modules"}</h2>
        <p class="mt-4 text-slate-600 text-base">${config.features_subtitle || "Everything your organization needs in one place."}</p>
      </div>
      <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        ${features.map(f => `
          <div class="p-6 rounded-2xl bg-white border border-slate-200 shadow-sm hover:shadow-md transition">
            <h3 class="text-lg font-bold text-slate-900">${f.title}</h3>
            <p class="mt-2 text-sm text-slate-600 leading-relaxed">${f.description}</p>
          </div>
        `).join('')}
      </div>
    </section>
  </main>

  <footer class="border-t border-slate-200 bg-white py-12 px-6">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-500">
      <div>${config.footer_company || siteName} — ${config.footer_text || "Modern Business Platform"}</div>
      <div>${config.footer_copyright || "© 2026 Taskosphere. All rights reserved."}</div>
    </div>
  </footer>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

