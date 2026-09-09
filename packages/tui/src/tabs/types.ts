export type TabName = 'dashboard' | 'queue' | 'costs' | 'log' | 'health';

export const TAB_ORDER: TabName[] = ['dashboard', 'queue', 'costs', 'log', 'health'];

export const TAB_LABELS: Record<TabName, string> = {
  dashboard: 'Active',
  queue: 'Queue',
  costs: 'Costs',
  log: 'Log',
  health: 'Health',
};
