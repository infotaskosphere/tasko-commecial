import React, { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  getAdminWebsiteConfig,
  saveWebsiteConfig,
  resetWebsiteConfig,
  downloadWebsiteConfig,
  downloadWebsiteHTML
} from "@/lib/websiteApi";

import WebsiteRenderer, { DEFAULT_BUILDER } from "./WebsiteRenderer";
import StudioTopBar from "./StudioTopBar";
import PageNavigator from "./PageNavigator";
import SectionPropertiesDrawer from "./SectionPropertiesDrawer";
import HeaderEditorDrawer from "./HeaderEditorDrawer";
import FooterEditorDrawer from "./FooterEditorDrawer";
import SectionLibraryModal from "./SectionLibraryModal";
import MediaLibraryModal from "./MediaLibraryModal";
import ThemeCustomizerModal from "./ThemeCustomizerModal";
import AiWebsiteAssistantModal from "./AiWebsiteAssistantModal";
import OnboardingWizardModal from "./OnboardingWizardModal";
import PublishModal from "./PublishModal";
import TextInlineModal from "./TextInlineModal";
import ButtonEditorModal from "./ButtonEditorModal";

const STORAGE_KEY = "taskosphere_saved_website_config";

export default function WebsiteStudio() {
  // Main Builder Configuration State
  const [config, setConfig] = useState(() => JSON.parse(JSON.stringify(DEFAULT_BUILDER)));
  const [identity, setIdentity] = useState({
    site_name: "ONENEXA",
    site_tagline: "One platform for modern business operations.",
    logo_url: "/onenexa-logo.png",
    favicon_url: "/onenexa-logo.png",
    footer_company: "ONENEXA",
    footer_text: "A configurable commercial business operating system.",
    footer_copyright: `© ${new Date().getFullYear()} ONENEXA. All rights reserved.`,
  });

  // UI State
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState("saved"); // 'saved' | 'unsaved' | 'saving' | 'published'
  const [deviceMode, setDeviceMode] = useState("desktop"); // 'desktop' | 'tablet' | 'mobile'
  const [isPreviewMode, setIsPreviewMode] = useState(false);

  // Selection State
  const [selectedSectionId, setSelectedSectionId] = useState(null);
  const [drawerType, setDrawerType] = useState(null); // null | 'section' | 'header' | 'footer'

  // Modal Dialogs
  const [showSectionLibrary, setShowSectionLibrary] = useState(false);
  const [showThemeCustomizer, setShowThemeCustomizer] = useState(false);
  const [showAiAssistant, setShowAiAssistant] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);

  // Direct In-Canvas Editing Targets
  const [mediaTarget, setMediaTarget] = useState(null); // { sectionId, fieldKey, currentUrl }
  const [textTarget, setTextTarget] = useState(null); // { sectionId, fieldKey, initialText }
  const [buttonTarget, setButtonTarget] = useState(null); // { sectionId, buttonKey }

  // Custom User Uploaded Media Library
  const [customMedia, setCustomMedia] = useState(() => {
    try {
      const stored = localStorage.getItem("onenexa_custom_media");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Undo / Redo History Stacks
  const historyRef = useRef([]);
  const futureRef = useRef([]);

  const pushHistory = useCallback((currentConfig) => {
    historyRef.current.push(JSON.parse(JSON.stringify(currentConfig)));
    if (historyRef.current.length > 30) historyRef.current.shift();
    futureRef.current = [];
    setSaveStatus("unsaved");
  }, []);

  const handleUndo = () => {
    if (!historyRef.current.length) return;
    const previous = historyRef.current.pop();
    futureRef.current.push(JSON.parse(JSON.stringify(config)));
    setConfig(previous);
    setSaveStatus("unsaved");
  };

  const handleRedo = () => {
    if (!futureRef.current.length) return;
    const next = futureRef.current.pop();
    historyRef.current.push(JSON.parse(JSON.stringify(config)));
    setConfig(next);
    setSaveStatus("unsaved");
  };

  // Keyboard shortcut listener for Ctrl+Z and Ctrl+Y
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (
        ((e.metaKey || e.ctrlKey) && e.key === "y") ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Z")
      ) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [config]);

  // Load existing website config on mount
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const saved = await getAdminWebsiteConfig();
        if (!alive) return;
        if (saved?.builder?.pages?.length) {
          setConfig(saved.builder);
        }
        if (saved) {
          setIdentity({
            site_name: saved.site_name || "ONENEXA",
            site_tagline: saved.site_tagline || "One platform for modern business operations.",
            logo_url: saved.logo_url || "/onenexa-logo.png",
            favicon_url: saved.favicon_url || "/onenexa-logo.png",
            footer_company: saved.footer_company || "ONENEXA",
            footer_text: saved.footer_text || "A configurable commercial business operating system.",
            footer_copyright: saved.footer_copyright || `© ${new Date().getFullYear()} ONENEXA. All rights reserved.`,
          });
        }
      } catch (err) {
        console.warn("Could not load remote config, using defaults:", err);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  // Sync custom media to local storage
  const handleAddCustomMedia = (item) => {
    const updated = [item, ...customMedia];
    setCustomMedia(updated);
    try {
      localStorage.setItem("onenexa_custom_media", JSON.stringify(updated));
    } catch {}
  };

  // Page Operations
  const activePage = config.pages?.find((p) => p.id === config.activePageId) || config.pages?.[0];

  const handleSelectPage = (pageId) => {
    setConfig((prev) => ({ ...prev, activePageId: pageId }));
    setSelectedSectionId(null);
    setDrawerType(null);
  };

  const handleAddPage = (newPage) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      pages: [...prev.pages, newPage],
      activePageId: newPage.id,
    }));
    toast.success(`Page "${newPage.name}" created!`);
  };

  const handleDuplicatePage = (pageId) => {
    const target = config.pages.find((p) => p.id === pageId);
    if (!target) return;
    pushHistory(config);
    const duplicated = {
      ...JSON.parse(JSON.stringify(target)),
      id: `page_${Date.now()}`,
      name: `${target.name} (Copy)`,
      slug: `${target.slug}-copy`,
    };
    setConfig((prev) => ({
      ...prev,
      pages: [...prev.pages, duplicated],
      activePageId: duplicated.id,
    }));
    toast.success(`Duplicated "${target.name}"`);
  };

  const handleDeletePage = (pageId) => {
    if (config.pages.length <= 1) {
      toast.error("Your website must have at least one page.");
      return;
    }
    pushHistory(config);
    const nextPages = config.pages.filter((p) => p.id !== pageId);
    setConfig((prev) => ({
      ...prev,
      pages: nextPages,
      activePageId: prev.activePageId === pageId ? nextPages[0].id : prev.activePageId,
    }));
    toast.success("Page deleted.");
  };

  const handleRenamePage = (pageId, newName) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => (p.id === pageId ? { ...p, name: newName } : p)),
    }));
  };

  const handleTogglePageVisibility = (pageId) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => (p.id === pageId ? { ...p, visible: p.visible === false } : p)),
    }));
  };

  const handleSetHomepage = (pageId) => {
    pushHistory(config);
    const targetIndex = config.pages.findIndex((p) => p.id === pageId);
    if (targetIndex < 0) return;
    const item = config.pages[targetIndex];
    const rest = config.pages.filter((p) => p.id !== pageId);
    setConfig((prev) => ({
      ...prev,
      pages: [{ ...item, slug: "/" }, ...rest],
      activePageId: item.id,
    }));
    toast.success(`"${item.name}" is now the homepage.`);
  };

  // Section Operations
  const handleSelectSection = (sectionId) => {
    setSelectedSectionId(sectionId);
    if (sectionId) {
      setDrawerType("section");
    } else {
      setDrawerType(null);
    }
  };

  const handleAddSection = (catalogItem) => {
    if (!activePage) return;
    pushHistory(config);
    const newSection = {
      id: `${catalogItem.type}_${Date.now()}`,
      type: catalogItem.type,
      title: catalogItem.title,
      visible: true,
      layout: catalogItem.layout || "split",
      data: JSON.parse(JSON.stringify(catalogItem.data || {})),
      style: {
        paddingTop: 80,
        paddingBottom: 80,
      },
    };

    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.id === activePage.id
          ? { ...p, sections: [...(p.sections || []), newSection] }
          : p
      ),
    }));

    setSelectedSectionId(newSection.id);
    setDrawerType("section");
    setShowSectionLibrary(false);
    toast.success(`Added ${catalogItem.title} section!`);
  };

  const handleMoveSection = (sectionId, dir) => {
    if (!activePage) return;
    pushHistory(config);
    const sections = [...(activePage.sections || [])];
    const index = sections.findIndex((s) => s.id === sectionId);
    if (index < 0) return;
    const target = index + dir;
    if (target < 0 || target >= sections.length) return;

    const temp = sections[index];
    sections[index] = sections[target];
    sections[target] = temp;

    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => (p.id === activePage.id ? { ...p, sections } : p)),
    }));
  };

  const handleDuplicateSection = (sectionId) => {
    if (!activePage) return;
    const target = activePage.sections?.find((s) => s.id === sectionId);
    if (!target) return;
    pushHistory(config);

    const duplicated = {
      ...JSON.parse(JSON.stringify(target)),
      id: `${target.type}_${Date.now()}`,
      title: `${target.title || target.type} (Copy)`,
    };

    const sections = [...(activePage.sections || [])];
    const index = sections.findIndex((s) => s.id === sectionId);
    sections.splice(index + 1, 0, duplicated);

    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => (p.id === activePage.id ? { ...p, sections } : p)),
    }));
    setSelectedSectionId(duplicated.id);
    toast.success("Section duplicated.");
  };

  const handleDeleteSection = (sectionId) => {
    if (!activePage) return;
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.id === activePage.id
          ? { ...p, sections: (p.sections || []).filter((s) => s.id !== sectionId) }
          : p
      ),
    }));
    if (selectedSectionId === sectionId) {
      setSelectedSectionId(null);
      setDrawerType(null);
    }
    toast.success("Section removed.");
  };

  const handleToggleSectionVisibility = (sectionId) => {
    if (!activePage) return;
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.id === activePage.id
          ? {
              ...p,
              sections: (p.sections || []).map((s) =>
                s.id === sectionId ? { ...s, visible: s.visible === false } : s
              ),
            }
          : p
      ),
    }));
  };

  // Section Patch Helpers
  const patchSectionData = (sectionId, patch) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.id === activePage.id
          ? {
              ...p,
              sections: (p.sections || []).map((s) =>
                s.id === sectionId ? { ...s, data: { ...s.data, ...patch } } : s
              ),
            }
          : p
      ),
    }));
  };

  const patchSectionStyle = (sectionId, patch) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.id === activePage.id
          ? {
              ...p,
              sections: (p.sections || []).map((s) =>
                s.id === sectionId ? { ...s, style: { ...s.style, ...patch } } : s
              ),
            }
          : p
      ),
    }));
  };

  // Direct In-Canvas Editing Handlers
  const handleEditText = (sectionId, fieldKey, initialText) => {
    setTextTarget({ sectionId, fieldKey, initialText });
  };

  const handleSaveEditText = (sectionId, fieldKey, newText) => {
    patchSectionData(sectionId, { [fieldKey]: newText });
    setTextTarget(null);
  };

  const handleEditImage = (sectionId, fieldKey, currentUrl) => {
    setMediaTarget({ sectionId, fieldKey, currentUrl });
  };

  const handleSelectMedia = (selectedUrl) => {
    if (!mediaTarget) return;
    if (mediaTarget.sectionId === "header") {
      setIdentity((prev) => ({ ...prev, logo_url: selectedUrl }));
      setConfig((prev) => ({
        ...prev,
        global: {
          ...prev.global,
          identity: { ...(prev.global?.identity || {}), logoUrl: selectedUrl },
        },
      }));
    } else if (mediaTarget.fieldKey.startsWith("gallery_")) {
      const idx = Number(mediaTarget.fieldKey.split("_")[1]);
      const currentItems = activePage.sections.find((s) => s.id === mediaTarget.sectionId)?.data?.items || [];
      const updated = [...currentItems];
      updated[idx] = selectedUrl;
      patchSectionData(mediaTarget.sectionId, { items: updated });
    } else {
      patchSectionData(mediaTarget.sectionId, { [mediaTarget.fieldKey]: selectedUrl });
    }
    setMediaTarget(null);
  };

  const handleEditButton = (sectionId, buttonKey) => {
    setButtonTarget({ sectionId, buttonKey });
  };

  const handleSaveButton = (buttonText, buttonHref) => {
    if (!buttonTarget) return;
    if (buttonTarget.buttonKey === "primary") {
      patchSectionData(buttonTarget.sectionId, { primaryText: buttonText, primaryHref: buttonHref });
    } else if (buttonTarget.buttonKey === "secondary") {
      patchSectionData(buttonTarget.sectionId, { secondaryText: buttonText, secondaryHref: buttonHref });
    } else {
      patchSectionData(buttonTarget.sectionId, { button: buttonText, href: buttonHref });
    }
    setButtonTarget(null);
  };

  // Header & Footer Patch
  const handlePatchHeader = (headerPatch) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      global: {
        ...prev.global,
        header: { ...prev.global?.header, ...headerPatch },
      },
    }));
  };

  const handlePatchFooter = (footerPatch) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      global: {
        ...prev.global,
        footer: { ...prev.global?.footer, ...footerPatch },
      },
    }));
  };

  const handlePatchIdentity = (identityPatch) => {
    setIdentity((prev) => ({ ...prev, ...identityPatch }));
    setConfig((prev) => ({
      ...prev,
      global: {
        ...prev.global,
        identity: {
          ...(prev.global?.identity || {}),
          siteName: identityPatch.site_name ?? prev.global?.identity?.siteName,
          tagline: identityPatch.site_tagline ?? prev.global?.identity?.tagline,
        },
      },
    }));
  };

  // Theme Customizer
  const handleApplyTheme = (themeSettings) => {
    pushHistory(config);
    setConfig((prev) => ({
      ...prev,
      global: {
        ...prev.global,
        design: {
          ...prev.global?.design,
          ...themeSettings,
        },
      },
    }));
    toast.success("Theme updated!");
  };

  // AI Assistant Complete Update
  const handleApplyAiGeneration = (aiGeneratedConfig) => {
    pushHistory(config);
    setConfig(aiGeneratedConfig);
  };

  // Save Website Configuration
  const handleSave = async () => {
    setSaveStatus("saving");
    try {
      const payload = {
        site_name: identity.site_name,
        site_tagline: identity.site_tagline,
        logo_url: identity.logo_url,
        favicon_url: identity.favicon_url,
        footer_company: identity.footer_company,
        footer_text: identity.footer_text,
        footer_copyright: identity.footer_copyright,
        builder: config,
      };
      await saveWebsiteConfig(payload);
      setSaveStatus("saved");
      toast.success("Website saved successfully!");
    } catch (err) {
      setSaveStatus("unsaved");
      toast.error("Failed to save website configuration.");
    }
  };

  // Publish Website to Public
  const handlePublish = async () => {
    await handleSave();
    setSaveStatus("published");
  };

  const selectedSection = activePage?.sections?.find((s) => s.id === selectedSectionId);

  // Responsive device container styling for canvas
  const canvasWidthClass =
    deviceMode === "mobile"
      ? "max-w-[390px] min-h-[750px] shadow-2xl rounded-[40px] border-[8px] border-slate-900 overflow-hidden my-6"
      : deviceMode === "tablet"
      ? "max-w-[768px] min-h-[850px] shadow-2xl rounded-[32px] border-[8px] border-slate-800 overflow-hidden my-6"
      : "w-full min-h-full";

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-slate-100 text-slate-900">
      {/* Top App Bar */}
      <StudioTopBar
        siteName={identity.site_name}
        activePageName={activePage?.name || "Page"}
        deviceMode={deviceMode}
        onDeviceChange={setDeviceMode}
        canUndo={historyRef.current.length > 0}
        canRedo={futureRef.current.length > 0}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSave={handleSave}
        onOpenPublish={() => setShowPublishModal(true)}
        onOpenAiAssistant={() => setShowAiAssistant(true)}
        onOpenOnboarding={() => setShowOnboarding(true)}
        onOpenThemeCustomizer={() => setShowThemeCustomizer(true)}
        onTogglePreviewMode={() => setIsPreviewMode(!isPreviewMode)}
        isPreviewMode={isPreviewMode}
        saveStatus={saveStatus}
      />

      {/* Main 3-Panel Workspace */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* LEFT PANEL: Pages & Menu Navigator (Hidden in live preview mode) */}
        {!isPreviewMode && (
          <PageNavigator
            pages={config.pages || []}
            activePageId={config.activePageId}
            onSelectPage={handleSelectPage}
            onAddPage={handleAddPage}
            onDuplicatePage={handleDuplicatePage}
            onDeletePage={handleDeletePage}
            onRenamePage={handleRenamePage}
            onToggleVisibility={handleTogglePageVisibility}
            onSetHomepage={handleSetHomepage}
            onOpenSectionLibrary={() => setShowSectionLibrary(true)}
            onOpenThemeCustomizer={() => setShowThemeCustomizer(true)}
            onOpenHeaderEditor={() => setDrawerType("header")}
            onOpenFooterEditor={() => setDrawerType("footer")}
          />
        )}

        {/* CENTER CANVAS: Visual Website Canvas */}
        <div className="min-w-0 flex flex-1 flex-col items-center overflow-x-hidden overflow-y-auto bg-slate-100 p-0 transition-all">
          <div className={`mx-auto bg-white transition-all duration-300 ${canvasWidthClass}`}>
            <WebsiteRenderer
              builder={config}
              identity={identity}
              editor={!isPreviewMode}
              selectedSectionId={selectedSectionId}
              onSelectSection={handleSelectSection}
              onSelectHeader={() => setDrawerType("header")}
              onSelectFooter={() => setDrawerType("footer")}
              onEditText={handleEditText}
              onEditImage={handleEditImage}
              onEditButton={handleEditButton}
              onMoveSection={handleMoveSection}
              onDuplicateSection={handleDuplicateSection}
              onDeleteSection={handleDeleteSection}
              onToggleSectionVisibility={handleToggleSectionVisibility}
            />
          </div>
        </div>

        {/* RIGHT PANEL: Visual Editing Drawer (Context-sensitive, hidden in preview) */}
        {!isPreviewMode && drawerType && (
          <aside className="w-80 min-w-0 shrink-0 border-l border-slate-200 bg-white shadow-xl flex flex-col z-30 animate-in slide-in-from-right duration-200">
            {drawerType === "section" && selectedSection && (
              <SectionPropertiesDrawer
                section={selectedSection}
                globalDesign={config.global?.design}
                onPatchSectionData={patchSectionData}
                onPatchSectionStyle={patchSectionStyle}
                onOpenMediaLibrary={(secId, field) =>
                  handleEditImage(secId, field, selectedSection.data?.[field])
                }
                onOpenButtonEditor={(secId, btnKey) => handleEditButton(secId, btnKey)}
                onClose={() => setDrawerType(null)}
              />
            )}

            {drawerType === "header" && (
              <HeaderEditorDrawer
                builder={config}
                identity={identity}
                onPatchHeader={handlePatchHeader}
                onPatchIdentity={handlePatchIdentity}
                onOpenMediaLibrary={(key) => handleEditImage("header", "logo", identity.logo_url)}
                onClose={() => setDrawerType(null)}
              />
            )}

            {drawerType === "footer" && (
              <FooterEditorDrawer
                builder={config}
                identity={identity}
                onPatchFooter={handlePatchFooter}
                onPatchIdentity={handlePatchIdentity}
                onClose={() => setDrawerType(null)}
              />
            )}
          </aside>
        )}
      </div>

      {/* MODAL DIALOGS */}
      {showSectionLibrary && (
        <SectionLibraryModal
          onAddSection={handleAddSection}
          onClose={() => setShowSectionLibrary(false)}
        />
      )}

      {mediaTarget && (
        <MediaLibraryModal
          currentValue={mediaTarget.currentUrl}
          onSelectImage={handleSelectMedia}
          onClose={() => setMediaTarget(null)}
          customMedia={customMedia}
          onAddCustomMedia={handleAddCustomMedia}
        />
      )}

      {textTarget && (
        <TextInlineModal
          sectionId={textTarget.sectionId}
          fieldKey={textTarget.fieldKey}
          initialText={textTarget.initialText}
          onSave={handleSaveEditText}
          onClose={() => setTextTarget(null)}
        />
      )}

      {buttonTarget && (
        <ButtonEditorModal
          initialText={
            buttonTarget.buttonKey === "primary"
              ? selectedSection?.data?.primaryText
              : buttonTarget.buttonKey === "secondary"
              ? selectedSection?.data?.secondaryText
              : selectedSection?.data?.button
          }
          initialHref={
            buttonTarget.buttonKey === "primary"
              ? selectedSection?.data?.primaryHref
              : buttonTarget.buttonKey === "secondary"
              ? selectedSection?.data?.secondaryHref
              : selectedSection?.data?.href
          }
          pages={config.pages || []}
          onSave={handleSaveButton}
          onClose={() => setButtonTarget(null)}
        />
      )}

      {showThemeCustomizer && (
        <ThemeCustomizerModal
          currentTheme={config.global?.design || {}}
          onApplyTheme={handleApplyTheme}
          onClose={() => setShowThemeCustomizer(false)}
        />
      )}

      {showAiAssistant && (
        <AiWebsiteAssistantModal
          config={config}
          onApplyChanges={handleApplyAiGeneration}
          onClose={() => setShowAiAssistant(false)}
        />
      )}

      {showOnboarding && (
        <OnboardingWizardModal
          onComplete={({ config: newConfig, identity: newIdentity }) => {
            pushHistory(config);
            setConfig(newConfig);
            setIdentity(newIdentity);
            setShowOnboarding(false);
            toast.success("Welcome to your new website! Click any element to customize.");
          }}
          onClose={() => setShowOnboarding(false)}
        />
      )}

      {showPublishModal && (
        <PublishModal
          config={config}
          identity={identity}
          onPublish={handlePublish}
          onClose={() => setShowPublishModal(false)}
          isPublished={saveStatus === "published"}
        />
      )}
    </div>
  );
}