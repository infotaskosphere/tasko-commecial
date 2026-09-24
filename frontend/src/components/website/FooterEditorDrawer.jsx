import React, { useState } from "react";
import {
  FileText,
  Mail,
  Phone,
  MapPin,
  Instagram,
  Facebook,
  Linkedin,
  Youtube,
  Twitter,
  MessageCircle,
  X,
  Check
} from "lucide-react";

export default function FooterEditorDrawer({
  builder,
  identity,
  onPatchFooter,
  onPatchIdentity,
  onClose,
}) {
  const f = builder.global?.footer || {};
  const [show, setShow] = useState(f.show !== false);
  const [company, setCompany] = useState(identity?.footer_company || f.company || "ONENEXA");
  const [text, setText] = useState(identity?.footer_text || f.text || "A configurable commercial business operating system.");
  const [copyright, setCopyright] = useState(identity?.footer_copyright || f.copyright || `© ${new Date().getFullYear()} ONENEXA. All rights reserved.`);
  const [email, setEmail] = useState(f.email || "");
  const [phone, setPhone] = useState(f.phone || "");
  const [address, setAddress] = useState(f.address || "");

  const [instagram, setInstagram] = useState(f.socials?.instagram || "");
  const [facebook, setFacebook] = useState(f.socials?.facebook || "");
  const [linkedin, setLinkedin] = useState(f.socials?.linkedin || "");
  const [youtube, setYoutube] = useState(f.socials?.youtube || "");
  const [xsocial, setXsocial] = useState(f.socials?.x || "");
  const [whatsapp, setWhatsapp] = useState(f.socials?.whatsapp || "");

  const handleSave = () => {
    onPatchFooter({
      show,
      company,
      text,
      copyright,
      email,
      phone,
      address,
      socials: {
        instagram,
        facebook,
        linkedin,
        youtube,
        x: xsocial,
        whatsapp,
      },
    });
    onPatchIdentity({
      footer_company: company,
      footer_text: text,
      footer_copyright: copyright,
    });
    onClose();
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
            <FileText size={16} />
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-900">Website Footer</h3>
            <p className="text-[11px] text-slate-400">Company info, copyright and contact</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
        >
          <X size={18} />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
          <input
            type="checkbox"
            checked={show}
            onChange={(e) => setShow(e.target.checked)}
            className="rounded"
          />
          Show footer on website
        </label>

        {show && (
          <>
            <div>
              <label className="block text-xs font-bold text-slate-700">Company Name</label>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700">Footer Tagline / Description</label>
              <textarea
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700">Copyright Line</label>
              <input
                type="text"
                value={copyright}
                onChange={(e) => setCopyright(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-3 pt-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Contact Touchpoints
              </span>

              <div>
                <label className="block text-[11px] text-slate-600">Email Address</label>
                <div className="relative mt-1">
                  <Mail size={14} className="absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="contact@company.com"
                    className="w-full rounded-xl border border-slate-200 py-2 pl-8 pr-3 text-xs outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-600">Phone Number</label>
                <div className="relative mt-1">
                  <Phone size={14} className="absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 98765 43210"
                    className="w-full rounded-xl border border-slate-200 py-2 pl-8 pr-3 text-xs outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-600">Office Address</label>
                <div className="relative mt-1">
                  <MapPin size={14} className="absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Financial District, City"
                    className="w-full rounded-xl border border-slate-200 py-2 pl-8 pr-3 text-xs outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Social Profiles
              </span>

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="Instagram Link"
                  value={instagram}
                  onChange={(e) => setInstagram(e.target.value)}
                  className="rounded-xl border border-slate-200 p-2 text-xs outline-none"
                />
                <input
                  type="text"
                  placeholder="LinkedIn Link"
                  value={linkedin}
                  onChange={(e) => setLinkedin(e.target.value)}
                  className="rounded-xl border border-slate-200 p-2 text-xs outline-none"
                />
                <input
                  type="text"
                  placeholder="YouTube Link"
                  value={youtube}
                  onChange={(e) => setYoutube(e.target.value)}
                  className="rounded-xl border border-slate-200 p-2 text-xs outline-none"
                />
                <input
                  type="text"
                  placeholder="WhatsApp Number"
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value)}
                  className="rounded-xl border border-slate-200 p-2 text-xs outline-none"
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-slate-100 p-4">
        <button
          type="button"
          onClick={handleSave}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white shadow-md hover:bg-blue-700"
        >
          Save Footer
        </button>
      </div>
    </div>
  );
}
