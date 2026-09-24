import React, { useState } from "react";
import { Search, Building2, KeyRound, User, Globe, Layers, X, ExternalLink } from "lucide-react";

export default function GlobalSearch({ licenses = [], modules = [], onSelect }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { customers: [], licenses: [], modules: [] };

    const matchingLicenses = (licenses || []).filter(l =>
      [l.license_key, l.customer_name, l.company_name, l.admin_name, l.customer?.email, l.customer?.gstin, l.invoice_no]
        .some(v => String(v || "").toLowerCase().includes(q))
    ).slice(0, 5);

    const matchingModules = (modules || []).filter(m =>
      [m.id, m.name, m.code, m.description].some(v => String(v || "").toLowerCase().includes(q))
    ).slice(0, 4);

    return {
      licenses: matchingLicenses,
      modules: matchingModules
    };
  }, [query, licenses, modules]);

  const hasResults = results.licenses.length > 0 || results.modules.length > 0;

  return (
    <div className="relative w-full max-w-md">
      <div className="relative">
        <Search size={16} className="absolute left-3.5 top-3 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search customer, license key, GSTIN, user, module..."
          className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-10 pr-9 text-xs shadow-sm outline-none transition focus:border-[#1F6FB2] focus:ring-2 focus:ring-[#1F6FB2]/10"
        />
        {query && (
          <button
            onClick={() => {
              setQuery("");
              setOpen(false);
            }}
            className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {open && query && (
        <div className="absolute left-0 right-0 top-full mt-2 z-50 rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100 text-[10px] font-bold uppercase text-slate-400">
            <span>Search Results for "{query}"</span>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">Close</button>
          </div>

          {!hasResults ? (
            <div className="py-6 text-center text-xs text-slate-400">
              No matching customers, licenses or modules found.
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 pt-1">
              {results.licenses.length > 0 && (
                <div className="py-2">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 px-2">
                    Customers & Licenses
                  </div>
                  {results.licenses.map(lic => (
                    <button
                      key={lic.id}
                      onClick={() => {
                        onSelect?.({ type: "license", item: lic });
                        setOpen(false);
                      }}
                      className="w-full flex items-center justify-between p-2 rounded-xl text-left hover:bg-slate-50 transition"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="p-1.5 rounded-lg bg-blue-50 text-blue-600 shrink-0">
                          <Building2 size={15} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">
                            {lic.company_name || lic.customer_name || lic.admin_name || "Unnamed"}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono truncate">
                            {lic.license_key} · {lic.status}
                          </div>
                        </div>
                      </div>
                      <ExternalLink size={13} className="text-slate-400 shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              )}

              {results.modules.length > 0 && (
                <div className="py-2">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 px-2">
                    Modules
                  </div>
                  {results.modules.map(mod => (
                    <button
                      key={mod.id}
                      onClick={() => {
                        onSelect?.({ type: "module", item: mod });
                        setOpen(false);
                      }}
                      className="w-full flex items-center justify-between p-2 rounded-xl text-left hover:bg-slate-50 transition"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="p-1.5 rounded-lg bg-purple-50 text-purple-600 shrink-0">
                          <Layers size={15} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate">{mod.name}</div>
                          <div className="text-[10px] text-slate-400 truncate">{mod.description}</div>
                        </div>
                      </div>
                      <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                        Catalog
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
