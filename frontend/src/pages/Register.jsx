import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Building2, CheckCircle2, LockKeyhole, Mail, Phone, ShieldCheck, User, UserPlus, Briefcase } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { createLicensedUser, verifyLicensedCompany } from "@/lib/licenseApi";
import { useAuth } from "@/contexts/AuthContext";

const Field = ({ id, label, icon: Icon, type = "text", placeholder, value, onChange, required = true }) => (
  <div className="space-y-1.5">
    <Label htmlFor={id} className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
      <Icon className="h-3.5 w-3.5 text-slate-400" />{label}
    </Label>
    <Input id={id} type={type} value={value} onChange={onChange} placeholder={placeholder} required={required}
      className="h-11 rounded-xl border-slate-200 bg-slate-50/70" />
  </div>
);

export default function Register() {
  const { login } = useAuth();
  const [step, setStep] = useState("company");
  const [companyName, setCompanyName] = useState("");
  const [company, setCompany] = useState(null);
  const [license, setLicense] = useState(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("not_known");
  const [busy, setBusy] = useState(false);

  const handleVerify = async (event) => {
    event.preventDefault();
    if (!companyName.trim()) return toast.error("Enter your registered company name.");
    setBusy(true);
    try {
      const result = await verifyLicensedCompany(companyName.trim());
      setCompany(result.company);
      setLicense(result.license);
      setStep("account");
      toast.success("Company verified. You can now create your account.");
    } catch (error) {
      setCompany(null);
      setLicense(null);
      toast.error(error?.response?.data?.detail || "This company could not be verified against an active license.");
    } finally { setBusy(false); }
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    if (!company) return toast.error("Verify your company first.");
    setBusy(true);
    try {
      const result = await createLicensedUser({
        company_name: company.company_name,
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        password,
        role,
      });
      login(result, true);
      try { window.postMessage({ type: "SET_TOKEN", token: result.access_token }, window.location.origin); } catch {}
      toast.success("Account created successfully. Welcome to Taskosphere!");
      // Do not call navigate() here: the <PublicOnly> guard around /register
      // already redirects to /dashboard as soon as the authenticated user is
      // set above. Calling navigate() too fires a second, competing route
      // transition in the same commit, which caused a
      // "Failed to execute 'insertBefore' on 'Node'" crash (same bug as Login.jsx).
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to create your account.");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen overflow-hidden bg-[linear-gradient(135deg,#eaf8f3_0%,#e7f5ff_48%,#dff4ff_100%)]">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-20 h-80 w-80 rounded-full bg-emerald-300/25 blur-3xl" />
        <div className="absolute right-[-90px] top-[-80px] h-96 w-96 rounded-full bg-blue-400/25 blur-3xl" />
        <div className="absolute bottom-[-100px] left-1/3 h-80 w-80 rounded-full bg-cyan-300/20 blur-3xl" />
      </div>

      <div className="relative mx-auto grid min-h-screen max-w-[1500px] lg:grid-cols-[1.05fr_.95fr]">
        <section className="hidden flex-col justify-center px-10 py-12 lg:flex xl:px-16">
          <div className="max-w-xl">
            <Link to="/login" className="inline-flex items-center gap-3">
              <img src="/logo.png" alt="Taskosphere" className="h-16 w-auto object-contain drop-shadow-sm" />
              <span className="text-xl font-black tracking-tight text-[#173f70]">Taskosphere</span>
            </Link>
            <div className="mt-16">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white/60 px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700 backdrop-blur">
                <ShieldCheck size={14} /> Licensed workspace
              </div>
              <h1 className="text-5xl font-black leading-[1.04] tracking-tight text-[#123b69] xl:text-6xl">
                Create your company account with confidence.
              </h1>
              <p className="mt-6 max-w-lg text-lg leading-8 text-slate-600">
                Your company name is checked against our licensed customer records before an account can be created.
              </p>
              <div className="mt-9 grid gap-3 sm:grid-cols-2">
                {["Active license verification", "Company-linked account", "Admin, Manager or Staff", "Secure workspace access"].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-sm font-semibold text-slate-600">
                    <CheckCircle2 size={17} className="text-emerald-500" />{item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="flex items-center justify-center px-4 py-8 sm:px-8 lg:px-10">
          <div className="w-full max-w-[540px] rounded-[2rem] border border-white/80 bg-white/95 p-6 shadow-[0_30px_80px_rgba(15,23,42,.16)] backdrop-blur-xl sm:p-9">
            <div className="mb-7 lg:hidden">
              <Link to="/login" className="flex items-center gap-3"><img src="/logo.png" alt="Taskosphere" className="h-11 w-auto" /><span className="font-bold text-[#173f70]">Taskosphere</span></Link>
            </div>

            <div className="mb-7">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                {step === "company" ? <Building2 size={22} /> : <UserPlus size={22} />}
              </div>
              <h2 className="text-3xl font-black tracking-tight text-slate-950">Create Account</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                {step === "company" ? "First verify the company whose Taskosphere license you will use." : "Your company is verified. Enter your personal account details."}
              </p>
            </div>

            <div className="mb-6 grid grid-cols-2 gap-2">
              <div className={`rounded-xl px-3 py-2.5 text-center text-xs font-bold ${step === "company" ? "bg-[#123b69] text-white" : "bg-emerald-50 text-emerald-700"}`}>1. Verify company</div>
              <div className={`rounded-xl px-3 py-2.5 text-center text-xs font-bold ${step === "account" ? "bg-[#123b69] text-white" : "bg-slate-100 text-slate-400"}`}>2. Create account</div>
            </div>

            {step === "company" ? (
              <form onSubmit={handleVerify} className="space-y-5">
                <Field id="companyName" label="Registered Company Name" icon={Building2} value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Enter the exact licensed company name" />
                <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
                  <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" /><div><p className="text-sm font-bold text-slate-800">License verification</p><p className="mt-1 text-xs leading-5 text-slate-600">We will verify the company name against our active commercial license records. No license number is required on this screen.</p></div></div>
                </div>
                <button type="submit" disabled={busy} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#123b69] to-emerald-500 text-sm font-bold text-white shadow-lg disabled:opacity-60">
                  {busy ? "Verifying company…" : <>Verify Company <ArrowRight size={17} /></>}
                </button>
              </form>
            ) : (
              <form onSubmit={handleCreate} className="space-y-4">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                  <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /><div><p className="font-bold text-slate-900">Company verified</p><p className="mt-1 text-xs text-slate-600">{company?.company_name} · {license?.remaining_users ?? "—"} user slot(s) available</p></div></div>
                </div>
                <Field id="fullName" label="Full Name" icon={User} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="John Doe" />
                <Field id="email" label="Email Address" icon={Mail} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
                <Field id="phone" label="Mobile Number" icon={Phone} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" required={false} />
                <Field id="password" label="Password" icon={LockKeyhole} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Minimum 8 characters" />

                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5 text-sm font-semibold text-slate-700"><Briefcase className="h-3.5 w-3.5 text-slate-400" /> Role</Label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger className="h-11 rounded-xl border-slate-200 bg-slate-50/70"><SelectValue placeholder="Select your role" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="staff">Staff</SelectItem>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="not_known">Not Know</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <button type="submit" disabled={busy} className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#123b69] to-emerald-500 text-sm font-bold text-white shadow-lg disabled:opacity-60">
                  {busy ? "Creating account…" : <>Create Account <UserPlus size={17} /></>}
                </button>
                <button type="button" onClick={() => setStep("company")} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-900">Use a different company</button>
              </form>
            )}

            <div className="mt-7 border-t border-slate-100 pt-5 text-center text-sm">
              <span className="text-slate-500">Already have an account? </span>
              <Link to="/login" className="font-bold text-emerald-600 hover:underline">Sign in</Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
