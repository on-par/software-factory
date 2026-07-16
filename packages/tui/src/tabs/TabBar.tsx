import type { JSX } from 'react';
import { Box, Text } from 'ink';
import { TAB_LABELS, TAB_ORDER, type TabName } from './types.js';

export interface TabBarProps {
  active: TabName;
}

export function TabBar({ active }: TabBarProps): JSX.Element {
  return (
    <Box>
      {TAB_ORDER.map((tab, i) => (
        <Text key={tab}>
          {tab === active ? (
            <Text bold inverse>
              [{i + 1} {TAB_LABELS[tab]}]
            </Text>
          ) : (
            <Text dimColor>
              {' '}
              {i + 1} {TAB_LABELS[tab]}{' '}
            </Text>
          )}
        </Text>
      ))}
      <Text dimColor> Tab/1-4 switch · q quit</Text>
    </Box>
  );
}
