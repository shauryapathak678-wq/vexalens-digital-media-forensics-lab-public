import { describe, expect, it } from 'vitest';
import { isSupabasePublishableKey } from './supabase';

function makeJwt(role: string): string {
  const payload = btoa(JSON.stringify({ role }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

describe('Supabase browser key validation', () => {
  it('accepts publishable keys and legacy anon JWTs', () => {
    expect(isSupabasePublishableKey('sb_publishable_example')).toBe(true);
    expect(isSupabasePublishableKey(makeJwt('anon'))).toBe(true);
  });

  it('rejects secret keys and service-role JWTs', () => {
    expect(isSupabasePublishableKey('sb_secret_example')).toBe(false);
    expect(isSupabasePublishableKey(makeJwt('service_role'))).toBe(false);
  });

  it('rejects malformed JWTs', () => {
    expect(isSupabasePublishableKey('header.not-json.signature')).toBe(false);
  });
});
