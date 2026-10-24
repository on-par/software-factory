// packages/core/src/config/provider-order-exports.ts — internal surface of provider-order.ts for #3338
export {
  isOpenCodeZenModel,
  OPENCODE_GO_DEFAULT_MODEL,
  PROVIDER_ORDER_ROLES,
  resolveRoleModel,
  SUBSCRIPTION_PROVIDERS,
  subscriptionProviderOf,
} from './provider-order.js';
export * from '../utils/provider-plan.js'; // detectProviderPlan, detectClaudePlan, codexHasApiKey (#3214)
export * from '../utils/subscription-login.js'; // subscriptionLogin, filterRefusedProviders (#3335)
export type { ProviderOrder, ProviderOrderRole, SubscriptionProviderId } from './provider-order.js';
