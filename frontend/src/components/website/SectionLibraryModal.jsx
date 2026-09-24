import React, { useState } from "react";
import {
  Layers,
  Sparkles,
  Layout,
  Type,
  Image as ImageIcon,
  Grid,
  FileQuestion,
  CreditCard,
  MessageSquare,
  Users,
  Compass,
  ArrowRight,
  Maximize2,
  Minus,
  CheckCircle2,
  Search
} from "lucide-react";

export const SECTION_CATALOG = [
  {
    category: "Hero",
    description: "Opening banner with bold titles, message and action buttons",
    items: [
      {
        type: "hero",
        layout: "split",
        theme: "executive",
        title: "Hero with Image (Executive)",
        desc: "High-contrast dark hero with headline, badges, 2 buttons, and right-side showcase image.",
        icon: Maximize2,
        data: {
          badge: "COMMERCIAL BUSINESS OPERATING SYSTEM",
          title: "Run your entire business from one workspace",
          subtitle: "Tasks, invoices, compliance, accounting and teams working in unison.",
          primaryText: "Get Started Now",
          primaryHref: "#features",
          secondaryText: "Sign in",
          secondaryHref: "/login",
          image: "/onenexa-logo.png",
          theme: "executive",
        },
      },
      {
        type: "hero",
        layout: "center",
        theme: "light",
        title: "Clean Centered Hero",
        desc: "Minimal, bright centered introduction with large bold text and primary call-to-action.",
        icon: Layout,
        data: {
          badge: "NEW GENERATION SUITE",
          title: "Intelligent Commercial Workspace",
          subtitle: "Designed for modern firms seeking clarity, speed, and disciplined operations.",
          primaryText: "Explore Platform",
          primaryHref: "#features",
          secondaryText: "Schedule Call",
          secondaryHref: "/login",
          contentAlign: "center",
          theme: "light",
        },
      },
    ],
  },
  {
    category: "Content",
    description: "Storytelling, text descriptions, rich media and portfolios",
    items: [
      {
        type: "imageText",
        title: "Text & Image Story",
        desc: "Split section pairing a rich description with a photo on the right.",
        icon: ImageIcon,
        data: {
          heading: "Built On Integrity, Precision & Trust",
          body: "We partner with ambitious enterprises and consultancies to streamline business processes, eliminate operational clutter, and ensure strict statutory compliance.",
          image: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=80",
          imageSide: "right",
        },
      },
      {
        type: "text",
        title: "Narrative Text Section",
        desc: "Clean headline and body text block for company mission, policy, or announcement.",
        icon: Type,
        data: {
          heading: "Why Choose Our Solution",
          body: "Single sign-on, centralized client registers, automated invoice generation, and automated compliance calendars ensure your firm never misses a deadline.",
        },
      },
      {
        type: "gallery",
        title: "Visual Photo Gallery",
        desc: "Grid of photos showcasing office premises, client milestones, or products.",
        icon: Grid,
        data: {
          items: [
            "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=800&q=80",
            "https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=800&q=80",
            "https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=800&q=80",
          ],
        },
      },
      {
        type: "image",
        title: "Full-Width Banner Image",
        desc: "Large high-resolution visual anchor across the website container.",
        icon: ImageIcon,
        data: {
          image: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80",
          alt: "Corporate headquarters",
        },
      },
      {
        type: "video",
        title: "Video Presentation",
        desc: "Responsive embed for YouTube, Vimeo or MP4 corporate overviews.",
        icon: Compass,
        data: {
          title: "Platform Walkthrough",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
      },
    ],
  },
  {
    category: "Business",
    description: "Features, service grids, client reviews and pricing tables",
    items: [
      {
        type: "features",
        title: "Feature / Capability Cards",
        desc: "Grid of cards with icons and descriptions highlighting capabilities.",
        icon: Sparkles,
        data: {
          heading: "One Platform. Every Business Function.",
          subtitle: "Activate the modules your firm requires through commercial licensing.",
          items: [
            { title: "Task & Project Management", description: "Tasks, milestones, reminders, and employee workloads.", route: "#" },
            { title: "Invoicing & Billing", description: "Sales invoices, GST billing, and payment tracking.", route: "#" },
            { title: "HRMS & Attendance", description: "Biometric sync, leaves, payroll and staff records.", route: "#" },
            { title: "Statutory Compliance", description: "ROC, GST reconciliation, and trademark tracking.", route: "#" },
            { title: "DSC & Document Vault", description: "Digital signature tokens and secure document records.", route: "#" },
            { title: "Commercial Security", description: "Enterprise role permissions and encrypted backups.", route: "#" },
          ],
        },
      },
      {
        type: "pricing",
        title: "Pricing Packages",
        desc: "Clear tiers with monthly/annual pricing, feature lists and sign-in buttons.",
        icon: CreditCard,
        data: {
          heading: "Transparent Commercial Packages",
          subtitle: "Choose the package tailored to your team's operational requirements.",
          items: [
            { name: "Starter Suite", price: "₹4,999", period: "/ month", description: "Tasks, invoices, and basic customer vault.", featured: false },
            { name: "Professional Suite", price: "₹9,999", period: "/ month", description: "Everything in Starter plus HRMS, Banking and Compliance.", featured: true },
            { name: "Enterprise Custom", price: "Custom", period: "/ year", description: "Dedicated cloud deployment, custom workflows and white-labeling.", featured: false },
          ],
        },
      },
      {
        type: "testimonials",
        title: "Client Testimonials",
        desc: "Social proof quotes with client names and organizational titles.",
        icon: MessageSquare,
        data: {
          heading: "Trusted by Industry Leaders",
          items: [
            { quote: "It transformed our practice operations and automated monthly billing completely.", name: "Sunil Mehta", role: "Founder, Mehta & Partners" },
            { quote: "Our staff onboarding and task tracking time reduced by half in the first month.", name: "Ananya Roy", role: "Head of Operations, FinEdge" },
          ],
        },
      },
      {
        type: "faq",
        title: "Frequently Asked Questions",
        desc: "Accordion questions and answers to clear customer doubts.",
        icon: FileQuestion,
        data: {
          heading: "Frequently Asked Questions",
          items: [
            { question: "How does the commercial license work?", answer: "Each license unlocks modules according to your agreement with the platform owner." },
            { question: "Can we migrate our existing customer data?", answer: "Yes, our team provides streamlined import utilities for customer and task records." },
            { question: "Is data backed up automatically?", answer: "Yes, automated cloud backups occur regularly with one-click restore capabilities." },
          ],
        },
      },
    ],
  },
  {
    category: "Conversion",
    description: "Forms, calls to action and enquiry capture",
    items: [
      {
        type: "cta",
        title: "Call to Action Banner",
        desc: "High-contrast closing statement that drives visitors to register or get in touch.",
        icon: ArrowRight,
        data: {
          heading: "Ready to Transform Your Business Operations?",
          text: "Configure your company's modules today and experience a connected workspace.",
          button: "Get Started Now",
          href: "/login",
        },
      },
      {
        type: "form",
        title: "Lead & Enquiry Form",
        desc: "Clean inquiry form capturing name, email, and visitor requirements.",
        icon: Users,
        data: {
          heading: "Speak With Our Solution Advisors",
        },
      },
    ],
  },
  {
    category: "Layout",
    description: "Dividers, line spacers and structural breaks",
    items: [
      {
        type: "divider",
        title: "Subtle Divider Line",
        desc: "Clean line separation between major sections.",
        icon: Minus,
        data: {},
      },
    ],
  },
];

export default function SectionLibraryModal({ onAddSection, onClose }) {
  const [activeCategory, setActiveCategory] = useState("Hero");
  const [search, setSearch] = useState("");

  const filteredCatalog = SECTION_CATALOG.map((cat) => {
    const matchingItems = cat.items.filter((item) => {
      const q = search.toLowerCase().trim();
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        cat.category.toLowerCase().includes(q)
      );
    });
    return { ...cat, items: matchingItems };
  }).filter((cat) => cat.items.length > 0);

  const currentCategory = filteredCatalog.find((c) => c.category === activeCategory) || filteredCatalog[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div className="flex h-[90vh] max-h-[750px] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
              <Layers size={20} />
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-900">Add a Section to Your Page</h2>
              <p className="text-xs text-slate-500">
                Choose a pre-designed section. You can customize text, pictures, and colors anytime.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>

        {/* Search & Categories */}
        <div className="flex flex-col gap-3 border-b border-slate-100 bg-slate-50/70 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {SECTION_CATALOG.map((cat) => (
              <button
                key={cat.category}
                type="button"
                onClick={() => {
                  setActiveCategory(cat.category);
                  setSearch("");
                }}
                className={`rounded-xl px-3.5 py-1.5 text-xs font-extrabold transition ${
                  activeCategory === cat.category && !search
                    ? "bg-blue-600 text-white shadow-sm"
                    : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                }`}
              >
                {cat.category}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search size={14} className="absolute left-3 top-3 text-slate-400" />
            <input
              type="text"
              placeholder="Search sections…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Content list */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(search ? filteredCatalog.flatMap((c) => c.items) : currentCategory?.items || []).map((item, idx) => {
              const Icon = item.icon || Layout;
              return (
                <div
                  key={idx}
                  onClick={() => onAddSection(item)}
                  className="group flex cursor-pointer flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-1 hover:border-blue-500 hover:shadow-lg"
                >
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700 group-hover:bg-blue-600 group-hover:text-white transition">
                        <Icon size={18} />
                      </div>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500 group-hover:bg-blue-50 group-hover:text-blue-700">
                        {item.type}
                      </span>
                    </div>
                    <h3 className="text-sm font-black text-slate-900 group-hover:text-blue-600">{item.title}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-slate-500">{item.desc}</p>
                  </div>

                  <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs font-bold text-blue-600">
                    <span>Add to page</span>
                    <ArrowRight size={14} className="transition group-hover:translate-x-1" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
