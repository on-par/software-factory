import { describe, expect, it } from 'vitest';

import { loadFactoryConfig } from '../config/index.js';
import { isFleetLeader, resolveFactoryHostId, resolveFleetLeader } from './fleet-leader.js';

describe('resolveFactoryHostId', () => {
  it('prefers a trimmed FACTORY_HOST_ID', () => {
    expect(resolveFactoryHostId({ FACTORY_HOST_ID: '  host-a ' }, 'box')).toBe('host-a');
  });

  it('falls back to the hostname when unset or blank', () => {
    expect(resolveFactoryHostId({}, 'box')).toBe('box');
    expect(resolveFactoryHostId({ FACTORY_HOST_ID: '  ' }, 'box')).toBe('box');
  });
});

describe('resolveFleetLeader', () => {
  it('is undefined by default', () => {
    expect(resolveFleetLeader(loadFactoryConfig())).toBeUndefined();
  });

  it('trims a set leader and treats blank as unset', () => {
    const config = loadFactoryConfig();
    expect(resolveFleetLeader({ ...config, fleet: { leader: ' host-a ' } })).toBe('host-a');
    expect(resolveFleetLeader({ ...config, fleet: { leader: '  ' } })).toBeUndefined();
  });
});

describe('isFleetLeader', () => {
  it('lets every host run when no leader is set', () => {
    expect(isFleetLeader(undefined, 'a')).toBe(true);
    expect(isFleetLeader('', 'a')).toBe(true);
    expect(isFleetLeader('   ', 'a')).toBe(true);
  });

  it('lets only the leader run when one is set', () => {
    expect(isFleetLeader('a', 'a')).toBe(true);
    expect(isFleetLeader(' a ', 'a')).toBe(true);
    expect(isFleetLeader('a', 'b')).toBe(false);
  });
});
