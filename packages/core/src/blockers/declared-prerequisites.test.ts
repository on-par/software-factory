import { describe, expect, it } from 'vitest';

import { findDeclaredPrerequisites } from './declared-prerequisites.js';

describe('findDeclaredPrerequisites', () => {
  it('accepts unique whole declaration lines in first-seen order', () => {
    expect(findDeclaredPrerequisites('Prerequisite: #12\n prerequisite: #4 \nPrerequisite: #12')).toEqual([12, 4]);
  });

  it('ignores other dependency syntax, malformed values, and formatted references', () => {
    expect(
      findDeclaredPrerequisites('Related: #2\nPrerequisite: #0\n> Prerequisite: #7\nPrerequisite: org/repo#8'),
    ).toEqual([]);
  });

  it('accepts the bullet form with trailing text (#3264, 2026-10-20)', () => {
    expect(findDeclaredPrerequisites('Notes\n- Prerequisite: #3263 (Slice A runner on main).\n')).toEqual([3263]);
  });

  it('counts only the first reference and accepts indented list markers', () => {
    expect(findDeclaredPrerequisites('Prerequisite: #12 and #13\n  * Prerequisite: #4')).toEqual([12, 4]);
    expect(findDeclaredPrerequisites('- Prerequisite: #6\n+ Prerequisite: #5 details\nPrerequisite: #3, #4')).toEqual([
      6, 5, 3,
    ]);
  });

  it('ignores blockquoted and fenced bullet declarations', () => {
    expect(findDeclaredPrerequisites('> - Prerequisite: #7')).toEqual([]);
    expect(findDeclaredPrerequisites('```\n- Prerequisite: #5\n```')).toEqual([]);
  });

  it('ignores fenced examples and respects marker and opening length', () => {
    expect(
      findDeclaredPrerequisites(
        '```md\nPrerequisite: #1\n``\nPrerequisite: #2\n~~~\nPrerequisite: #3\n~~~\nPrerequisite: #4\n````\nPrerequisite: #5\n```\nPrerequisite: #6\n````\nPrerequisite: #7',
      ),
    ).toEqual([5, 7]);
  });

  it('ignores unsafe integers and unclosed fences', () => {
    expect(findDeclaredPrerequisites('Prerequisite: #9007199254740992')).toEqual([]);
    expect(findDeclaredPrerequisites('Prerequisite: #8\n~~~\nPrerequisite: #9')).toEqual([8]);
  });
});
