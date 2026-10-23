// packages/core/src/config/provider-order-exports.ts — internal surface of provider-order.ts for #3338
export {
  isOpenCodeZenModel,
  PROVIDER_ORDER_ROLES,
  resolveRoleModel,
  SUBSCRIPTION_PROVIDERS,
  subscriptionProviderOf,
} from './provider-order.js';
export * from '../utils/provider-plan.js'; // detectProviderPlan, detectClaudePlan, codexHasApiKey (#3214)
export type { ProviderOrder, ProviderOrderRole, SubscriptionProviderId } from './provider-order.js';
