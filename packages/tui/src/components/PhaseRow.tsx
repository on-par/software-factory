import type { JSX } from 'react';
import { Box, Text } from 'ink';
import { PHASES, type RunState } from '../state.js';

// A small, self-contained "dots" cycle — avoids pulling in ink-spinner, whose
// nested `ink`/`react` copy would otherwise duplicate the reconciler in this tree.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length];
}

export function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function formatElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '00:00';
  return formatDuration(now - Date.parse(startedAt));
}

export interface PhaseRowProps {
  state: RunState;
  now: number;
}

export function PhaseRow({ state, now }: PhaseRowProps): JSX.Element {
  return (
    <Box>
      {PHASES.map((phase, i) => {
        const status = state.phaseStatus[phase];
        const isLast = i === PHASES.length - 1;
        return (
          <Box key={phase}>
            {status === 'done' && <Text color="green">✔ {phase}</Text>}
            {status === 'active' && (
              <Text>
                <Text color="yellow">{spinnerFrame(now)}</Text> {phase}
                {' ('}
                {state.model ?? '?'}
                {' · '}
                {state.route ?? '?'}
                {' · '}
                {formatElapsed(state.phaseStartedAt, now)}
                {')'}
              </Text>
            )}
            {status === 'pending' && <Text dimColor>{phase}</Text>}
            {!isLast && <Text dimColor> {'→'} </Text>}
          </Box>
        );
      })}
    </Box>
  );
}
