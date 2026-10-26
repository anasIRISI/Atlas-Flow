import { describe, expect, it } from 'vitest';
import { isValidEmail, passwordProblems } from '../src/auth.js';
import { isWsRoom } from '../src/ws.js';

describe('password policy', () => {
  it('accepts a password with 8+ chars, a number and a capital letter', () => {
    expect(passwordProblems('Forge2026')).toEqual([]);
  });

  it('lists every broken rule', () => {
    expect(passwordProblems('abc')).toHaveLength(3);
    expect(passwordProblems('abcdefgh1')).toEqual(['At least 1 capital letter']);
    expect(passwordProblems('Abcdefgh')).toEqual(['At least 1 number']);
    expect(passwordProblems('A1' + 'x'.repeat(70))).toEqual(['8–64 characters']);
  });
});

describe('email validation', () => {
  it.each(['a@b.co', ' owner@school.edu '])('accepts %s', (email) => expect(isValidEmail(email)).toBe(true));
  it.each(['', 'nope', 'a@b', 'a b@c.d'])('rejects %s', (email) => expect(isValidEmail(email)).toBe(false));
});

describe('websocket rooms', () => {
  it('accepts workflow and execution rooms only', () => {
    expect(isWsRoom('workflow:abc-123')).toBe(true);
    expect(isWsRoom('execution:42')).toBe(true);
    expect(isWsRoom('admin:1')).toBe(false);
    expect(isWsRoom('workflow:')).toBe(false);
    expect(isWsRoom(5)).toBe(false);
  });
});
