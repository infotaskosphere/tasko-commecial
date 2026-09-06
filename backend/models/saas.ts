export type CompanyStatus = "active" | "suspended" | "cancelled";
export type SubscriptionStatus = "trial" | "active" | "expired" | "suspended" | "cancelled";

export type SaaSCompany = {
  _id?: unknown;
  name: string;
  slug: string;
  status: CompanyStatus;
  created_at: Date;
  updated_at: Date;
};

export type SaaSUser = {
  _id?: unknown;
  company_id: unknown;
  email: string;
  full_name: string;
  password_hash: string;
  role: string;
  permissions: Record<string, unknown>;
  status: "active" | "disabled";
  created_at: Date;
  updated_at: Date;
};

export type SaaSSubscription = {
  _id?: unknown;
  company_id: unknown;
  package_id: string;
  status: SubscriptionStatus;
  max_users: number;
  max_installations: number;
  modules: string[];
  starts_at: Date;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

export type SaaSSession = {
  _id?: unknown;
  user_id: unknown;
  company_id: unknown;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
};
