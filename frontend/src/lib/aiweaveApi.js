/**
 * AIWeave API Client Layer
 * Uses the application's authenticated Axios client and the real backend.
 * Mutations never fall back to local browser state.
 */
import api from "./api";

export const listProviders = async () => (await api.get("/aiweave/providers")).data;
export const listAccounts = async () => (await api.get("/aiweave/accounts")).data;
export const connectAccount = async (payload) => (await api.post("/aiweave/accounts/connect", payload)).data;
export const testAccount = async (accountId) => (await api.post(`/aiweave/accounts/${encodeURIComponent(accountId)}/test`)).data;
export const toggleAccount = async (accountId) => (await api.post(`/aiweave/accounts/${encodeURIComponent(accountId)}/toggle`)).data;
export const updateAccount = async (accountId, updates) => (await api.patch(`/aiweave/accounts/${encodeURIComponent(accountId)}`, updates)).data;
export const deleteAccount = async (accountId) => (await api.delete(`/aiweave/accounts/${encodeURIComponent(accountId)}`)).data;
export const getModels = async () => (await api.get("/aiweave/models")).data;
export const getRoutingConfig = async () => (await api.get("/aiweave/routing-config")).data;
export const updateRoutingConfig = async (payload) => (await api.put("/aiweave/routing-config", payload)).data;
export const getExecutionHistory = async () => (await api.get("/aiweave/executions")).data;
export const executeTask = async (payload, config = {}) => (await api.post("/aiweave/execute", payload, config)).data;
export const executeOmni = async (payload, config = {}) => (await api.post("/aiweave/omni", payload, config)).data;
export const getStats = async () => (await api.get("/aiweave/stats")).data;

export const listConversations = async () => (await api.get("/aiweave/conversations")).data;
export const createConversation = async (payload = {}) => (await api.post("/aiweave/conversations", payload)).data;
export const getConversation = async (conversationId) => (await api.get(`/aiweave/conversations/${encodeURIComponent(conversationId)}`)).data;
export const deleteConversation = async (conversationId) => (await api.delete(`/aiweave/conversations/${encodeURIComponent(conversationId)}`)).data;

export default {
  listProviders, listAccounts, connectAccount, testAccount, toggleAccount,
  updateAccount, deleteAccount, getModels, getRoutingConfig, updateRoutingConfig,
  getExecutionHistory, executeTask, executeOmni, getStats, listConversations, createConversation,
  getConversation, deleteConversation,
};

