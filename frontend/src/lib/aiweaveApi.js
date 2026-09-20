import api from "./api";

// AIWeave service adapter. Endpoint names are centralized here so the page never
// embeds transport details. Server-side authentication and entitlement checks
// remain authoritative.
const request = (method, url, data, config = {}) => api({ method, url, data, ...config });

export const listProviders = async () => (await api.get("/aiweave/providers")).data;
export const listAccounts = async () => (await api.get("/aiweave/accounts")).data;
export const connectAccount = async (payload) => (await api.post("/aiweave/accounts", payload)).data;
export const testAccount = async (accountId) => (await api.post(`/aiweave/accounts/${encodeURIComponent(accountId)}/test`)).data;
export const toggleAccount = async (accountId) => (await api.post(`/aiweave/accounts/${encodeURIComponent(accountId)}/toggle`)).data;
export const updateAccount = async (accountId, payload) => (await api.patch(`/aiweave/accounts/${encodeURIComponent(accountId)}`, payload)).data;
export const deleteAccount = async (accountId) => (await api.delete(`/aiweave/accounts/${encodeURIComponent(accountId)}`)).data;
export const getModels = async () => (await api.get("/aiweave/models")).data;
export const getRoutingConfig = async () => (await api.get("/aiweave/routing")).data;
export const updateRoutingConfig = async (payload) => (await api.patch("/aiweave/routing", payload)).data;
export const getExecutionHistory = async () => (await api.get("/aiweave/executions")).data;
export const executeTask = async (payload) => (await api.post("/aiweave/execute", payload)).data;
export const getStats = async () => (await api.get("/aiweave/stats")).data;

export default {
  listProviders, listAccounts, connectAccount, testAccount, toggleAccount,
  updateAccount, deleteAccount, getModels, getRoutingConfig, updateRoutingConfig,
  getExecutionHistory, executeTask, getStats,
};
