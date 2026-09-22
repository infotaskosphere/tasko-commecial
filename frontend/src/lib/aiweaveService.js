/**
 * AIWeave local compatibility metadata only.
 * Production state and all credentials remain server-authoritative.
 */
import { PROVIDERS, INITIAL_MODELS, AIWEAVE_DEFAULT_ROUTING } from "./aiweaveConstants";

export const aiweaveService = {
  getProviders: () => PROVIDERS.map((p) => ({
    ...p,
    accountCount: 0,
    connectedCount: 0,
    healthyCount: 0,
    availableModelsCount: INITIAL_MODELS.filter((m) => m.provider === p.id).length,
    freeModelsCount: INITIAL_MODELS.filter((m) => m.provider === p.id && m.isFree).length,
  })),
  getAccounts: () => [],
  getModels: () => INITIAL_MODELS,
  getRoutingConfig: () => ({ ...AIWEAVE_DEFAULT_ROUTING }),
  getExecutions: () => [],
  getStats: () => ({
    activeProvidersCount: 0,
    totalAccounts: 0,
    healthyAccounts: 0,
    exhaustedAccounts: 0,
    totalTokensTracked: 0,
    totalExecutionsCount: 0,
    fallbackExecutions: 0,
    freeModelsCount: INITIAL_MODELS.filter((m) => m.isFree).length,
    totalModelsCount: INITIAL_MODELS.length,
    // Kept in sync with GET /aiweave/stats so any UI reading this offline
    // stub (before the real API responds) doesn't hit undefined fields.
    freeAccountsCount: 0,
    paidAccountsCount: 0,
    unknownTierAccountsCount: 0,
    freeAccountsResting: 0,
    freeTierTokensUsedToday: 0,
    freeExecutionsCount: 0,
    freeExecutionShare: null,
  }),
};

export default aiweaveService;
