export type TabName = 'dashboard' | 'queue' | 'costs' | 'log';

export const TAB_ORDER: TabName[] = ['dashboard', 'queue', 'costs', 'log'];

export const TAB_LABELS: Record<TabName, string> = {
  dashboard: 'Dashboard',
  queue: 'Queue',
  costs: 'Costs',
  log: 'Log',
};
