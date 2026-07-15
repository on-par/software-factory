import type { JSX } from 'react';
import { Text } from 'ink';

export interface StopBannerProps {
  reason: string;
}

export function StopBanner({ reason }: StopBannerProps): JSX.Element {
  return (
    <Text backgroundColor="red" color="white" bold>
      {' '}
      ⛔ FACTORY STOPPED — {reason}{' '}
    </Text>
  );
}
