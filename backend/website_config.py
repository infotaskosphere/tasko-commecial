import copy
from typing import Any, Dict

from fastapi import APIRouter, Depends

from backend.dependencies import db, require_admin


router = APIRouter(prefix="/website-config", tags=["commercial-website"])

DEFAULT_WEBSITE_CONFIG: Dict[str, Any] = {
    "site_name": "Taskosphere",
    "site_tagline": "One platform for tasks, finance, compliance and people.",
    "logo_url": "/logo.png",
    "favicon_url": "/favicon.png",
    "primary_color": "#0D3B66",
    "accent_color": "#1FAF5A",
    "surface_color": "#F7FAFC",
    "nav_links": [
        {"label": "Features", "href": "#features"},
        {"label": "Solutions", "href": "#solutions"},
        {"label": "Pricing", "href": "#pricing"},
        {"label": "Contact", "href": "#contact"},
    ],
    "hero_badge": "The modern business operating system",
    "hero_title": "Run your entire business from one intelligent workspace.",
    "hero_subtitle": "Task management, invoicing, accounting, HRMS and compliance — designed as one connected commercial platform.",
    "hero_cta_text": "Explore Taskosphere",
    "hero_cta_href": "#features",
    "hero_secondary_text": "Sign in",
    "hero_secondary_href": "/login",
    "hero_image_url": "/logo-transparent.png",
    "features_title": "Everything your team needs. Nothing scattered.",
    "features_subtitle": "Build the exact software package your customer needs and activate it through your commercial license.",
    "features": [
        {"title": "Task Management", "description": "Projects, tasks, workflows, reminders and team visibility in one place.", "icon": "check"},
        {"title": "Invoicing", "description": "Sales, quotations, purchases and customer billing without switching systems.", "icon": "receipt"},
        {"title": "Accounting", "description": "Ledgers, banking, reports and financial controls for a connected finance layer.", "icon": "landmark"},
        {"title": "HRMS", "description": "People, attendance, leave, payroll and recruitment with permission-aware access.", "icon": "users"},
        {"title": "Compliance", "description": "GST, ROC, trademark and compliance workflows built into the operating system.", "icon": "shield"},
        {"title": "AI & Automation", "description": "Intelligent document processing, automation and operational assistance.", "icon": "sparkles"},
    ],
    "solutions_title": "Choose the package. Make it yours.",
    "solutions_subtitle": "Commercial editions can be positioned for different customer sizes and operating models.",
    "solutions": [
        {"title": "Essential", "description": "For teams starting with tasks and invoicing.", "points": ["Task management", "Invoicing", "Core dashboards"]},
        {"title": "Professional", "description": "For growing businesses that need people operations too.", "points": ["Everything in Essential", "HRMS", "Advanced workflows"]},
        {"title": "Enterprise", "description": "For businesses that want a complete operating layer.", "points": ["Everything in Professional", "Accounting", "Compliance & automation"]},
    ],
    "pricing_title": "Simple commercial packaging",
    "pricing_subtitle": "Use the Master Console to manage packages, customer entitlements and licenses.",
    "pricing": [
        {"name": "Essential", "price": "Custom", "period": "per business", "description": "Tasks + Invoicing", "featured": False, "cta": "Talk to us"},
        {"name": "Professional", "price": "Custom", "period": "per business", "description": "Tasks + Invoicing + HRMS", "featured": True, "cta": "Talk to us"},
        {"name": "Enterprise", "price": "Custom", "period": "per business", "description": "Tasks + Invoicing + Accounting + HRMS", "featured": False, "cta": "Talk to us"},
    ],
    "testimonials_title": "Built for serious business operations.",
    "testimonials": [
        {"quote": "A single workspace makes our daily operations much easier to control.", "name": "Business Owner", "role": "Taskosphere Customer"},
        {"quote": "The modular commercial approach lets us buy exactly what the business needs.", "name": "Operations Lead", "role": "Taskosphere Customer"},
    ],
    "cta_title": "Ready to make your software feel like your own brand?",
    "cta_subtitle": "Configure your public website, login experience and commercial packages from the Master Console.",
    "cta_button_text": "Sign in to Taskosphere",
    "cta_button_href": "/login",
    "footer_company": "Taskosphere",
    "footer_text": "A configurable commercial business operating system.",
    "footer_email": "",
    "footer_phone": "",
    "footer_address": "",
    "footer_copyright": "© 2026 Taskosphere. All rights reserved.",
    "seo_title": "Taskosphere — Business Operating System",
    "seo_description": "Task management, invoicing, accounting, HRMS and compliance in one connected platform.",
    "seo_og_image": "/logo-transparent.png",
    "login_title": "Welcome Back",
    "login_subtitle": "Sign in to your Taskosphere workspace",
    "login_card_note": "One secure workspace for your team's daily operations.",
    "login_background_image": "",
    "login_show_website_link": True,
    "login_website_link_text": "Visit website",
    # Holds the full Website Studio page-builder tree (pages/sections/design).
    # Kept as its own nested key so it never collides with the flat legacy
    # fields above, and so a payload that only updates `builder` cannot wipe
    # SEO/login/footer settings edited elsewhere.
    "builder": None,
    "updated_at": None,
}


def _public_config(doc: Dict[str, Any] | None) -> Dict[str, Any]:
    config = copy.deepcopy(DEFAULT_WEBSITE_CONFIG)
    if doc:
        config.update({k: v for k, v in doc.items() if k != "_id"})
    # Extract synchronized root fields from builder if present
    builder = config.get("builder")
    if isinstance(builder, dict):
        identity = builder.get("global", {}).get("identity", {})
        if identity.get("siteName"):
            config["site_name"] = identity["siteName"]
        if identity.get("tagline"):
            config["site_tagline"] = identity["tagline"]
        if identity.get("logoUrl"):
            config["logo_url"] = identity["logoUrl"]
        if identity.get("faviconUrl"):
            config["favicon_url"] = identity["faviconUrl"]

        design = builder.get("global", {}).get("design", {})
        if design.get("primary"):
            config["primary_color"] = design["primary"]
        if design.get("accent"):
            config["accent_color"] = design["accent"]

        footer = builder.get("global", {}).get("footer", {})
        if footer.get("company"):
            config["footer_company"] = footer["company"]
        if footer.get("text"):
            config["footer_text"] = footer["text"]
        if footer.get("copyright"):
            config["footer_copyright"] = footer["copyright"]

        pages = builder.get("pages", [])
        if isinstance(pages, list) and pages:
            first_page = pages[0]
            sections = first_page.get("sections", [])
            for s in sections:
                if s.get("type") == "hero" and isinstance(s.get("data"), dict):
                    hd = s["data"]
                    if hd.get("title"):
                        config["hero_title"] = hd["title"]
                    if hd.get("subtitle"):
                        config["hero_subtitle"] = hd["subtitle"]
                    if hd.get("badge"):
                        config["hero_badge"] = hd["badge"]
                    if hd.get("primaryText"):
                        config["hero_cta_text"] = hd["primaryText"]
                    if hd.get("primaryHref"):
                        config["hero_cta_href"] = hd["primaryHref"]
                    if hd.get("secondaryText"):
                        config["hero_secondary_text"] = hd["secondaryText"]
                    if hd.get("secondaryHref"):
                        config["hero_secondary_href"] = hd["secondaryHref"]
                    if hd.get("image"):
                        config["hero_image_url"] = hd["image"]
                    break
    return config


@router.get("/public")
async def get_public_website_config():
    doc = await db.commercial_website_config.find_one({"id": "default"}, {"_id": 0})
    return _public_config(doc)


@router.get("/admin")
async def get_admin_website_config(current_user=Depends(require_admin())):
    doc = await db.commercial_website_config.find_one({"id": "default"}, {"_id": 0})
    return _public_config(doc)


@router.put("")
async def save_website_config(payload: Dict[str, Any], current_user=Depends(require_admin())):
    config = _public_config(payload)
    config["id"] = "default"
    from datetime import datetime, timezone
    config["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.commercial_website_config.update_one(
        {"id": "default"},
        {"$set": config},
        upsert=True,
    )
    config.pop("id", None)
    return config


@router.post("/reset")
async def reset_website_config(current_user=Depends(require_admin())):
    from datetime import datetime, timezone
    config = copy.deepcopy(DEFAULT_WEBSITE_CONFIG)
    config["id"] = "default"
    config["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.commercial_website_config.update_one(
        {"id": "default"},
        {"$set": config},
        upsert=True,
    )
    config.pop("id", None)
    return config
