// packages/cli/src/cli/merge-scope.test.ts

import { describe, expect, it } from 'vitest';
import { mergeScopeNotice } from './merge-scope.js';

describe('mergeScopeNotice', () => {
  it('returns undefined when neither merge env var is set', () => {
    expect(mergeScopeNotice({}, 42)).toBeUndefined();
  });

  it('names FACTORY_MERGE and points at factory land / factory run', () => {
    const notice = mergeScopeNotice({ FACTORY_MERGE: '1' }, 42);
    expect(notice).toContain('FACTORY_MERGE=1');
    expect(notice).toContain('factory land 42');
    expect(notice).toContain('factory run');
    expect(notice).not.toContain('FACTORY_MERGE_ADMIN');
  });

  it('names FACTORY_MERGE_ADMIN alone', () => {
    const notice = mergeScopeNotice({ FACTORY_MERGE_ADMIN: '1' }, 42);
    expect(notice).toContain('FACTORY_MERGE_ADMIN=1');
  });

  it('names both when both are set, in a single notice', () => {
    const notice = mergeScopeNotice({ FACTORY_MERGE: '1', FACTORY_MERGE_ADMIN: '1' }, 42);
    expect(notice).toContain('FACTORY_MERGE=1');
    expect(notice).toContain('FACTORY_MERGE_ADMIN=1');
  });

  it('only treats the literal value "1" as set', () => {
    expect(mergeScopeNotice({ FACTORY_MERGE: '0' }, 42)).toBeUndefined();
    expect(mergeScopeNotice({ FACTORY_MERGE: 'true' }, 42)).toBeUndefined();
  });
});
