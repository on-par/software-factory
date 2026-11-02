// packages/core/src/config/provider-order-exports.ts — internal surface of provider-order.ts for #3338
export { OPENCODE_GO_DEFAULT_MODEL, type ProviderOrder } from './provider-order.js';
export { detectClaudePlan, providerPlan, meteredPrimaryRouteWarnings } from '../utils/provider-plan.js'; // detectClaudePlan (#3214)
export {
  filterRefusedProviders,
  type SubscriptionLoginDeps,
  type RefusedProvider,
} from '../utils/subscription-login.js'; // filterRefusedProviders (#3335)
