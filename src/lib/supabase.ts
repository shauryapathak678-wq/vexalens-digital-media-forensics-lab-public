/**
 * VexaLens — Supabase client, auth helpers, and connection utilities.
 * Single source of truth for the Supabase singleton across the app.
 * Environment variables consumed:
 *   VITE_SUPABASE_URL              — project URL
 *   VITE_SUPABASE_ANON_KEY         — publishable/anon key (legacy alias)
 *   VITE_SUPABASE_PUBLISHABLE_KEY  — publishable/anon key (preferred)
 */
import { createClient, SupabaseClient, User, Session, AuthError } from '@supabase/supabase-js';
import type { UserProfile } from '@/types/forensics';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STORAGE_KEY_URL = 'vexalens_supabase_url';
const STORAGE_KEY_ANON = 'vexalens_supabase_anon_key';
const STORAGE_KEY_CONNECTION_STATUS = 'vexalens_supabase_connection_status';
const STORAGE_KEY_CONNECTION_CHECKED_AT = 'vexalens_supabase_connection_checked_at';
export const CONNECTION_STATUS_EVENT = 'vexalens-supabase-connection-status';
export const AUTH_STATE_EVENT = 'vexalens-auth-state-changed';

export function isSupabasePublishableKey(key: string): boolean {
  const normalizedKey = key.trim();
  if (!normalizedKey || /^sb_secret_/i.test(normalizedKey)) return false;

  const parts = normalizedKey.split('.');
  if (parts.length !== 3) return true;

  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='));
    const claims = JSON.parse(decoded) as { role?: string };
    return claims.role !== 'service_role';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config resolution — env vars take precedence, then localStorage override
// ---------------------------------------------------------------------------
export function getSupabaseConfig(): { url: string; anonKey: string } {
  const envUrl = (import.meta as any).env?.VITE_SUPABASE_URL || '';
  const envKeys = [
    (import.meta as any).env?.VITE_SUPABASE_PUBLISHABLE_KEY,
    (import.meta as any).env?.VITE_SUPABASE_ANON_KEY,
  ].filter((key): key is string => typeof key === 'string' && isSupabasePublishableKey(key));

  const localUrl = localStorage.getItem(STORAGE_KEY_URL) || '';
  const localAnon = localStorage.getItem(STORAGE_KEY_ANON) || '';
  if (localAnon && !isSupabasePublishableKey(localAnon)) {
    localStorage.removeItem(STORAGE_KEY_ANON);
    localStorage.removeItem(STORAGE_KEY_CONNECTION_STATUS);
    localStorage.removeItem(STORAGE_KEY_CONNECTION_CHECKED_AT);
  }

  return {
    url: localUrl || envUrl,
    anonKey: isSupabasePublishableKey(localAnon) ? localAnon : envKeys[0] || '',
  };
}

export function saveSupabaseConfig(url: string, anonKey: string): void {
  if (!isSupabasePublishableKey(anonKey)) {
    throw new Error('This key is not safe for browser use. Use a Supabase publishable key or legacy anon key; secret/service-role keys are blocked.');
  }
  localStorage.setItem(STORAGE_KEY_URL, url.trim());
  localStorage.setItem(STORAGE_KEY_ANON, anonKey.trim());
  localStorage.removeItem(STORAGE_KEY_CONNECTION_STATUS);
  localStorage.removeItem(STORAGE_KEY_CONNECTION_CHECKED_AT);
  _cachedClient = null;
  window.dispatchEvent(new Event(CONNECTION_STATUS_EVENT));
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseConfig();
  return Boolean(url && anonKey && url.startsWith('http') && anonKey.length > 10);
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------
export type SupabaseConnectionStatus = 'not_configured' | 'not_tested' | 'passed' | 'failed';

export function getSupabaseConnectionStatus(): { status: SupabaseConnectionStatus; checkedAt: string | null } {
  if (!isSupabaseConfigured()) return { status: 'not_configured', checkedAt: null };
  const status = localStorage.getItem(STORAGE_KEY_CONNECTION_STATUS);
  const checkedAt = localStorage.getItem(STORAGE_KEY_CONNECTION_CHECKED_AT);
  return {
    status: status === 'passed' || status === 'failed' ? status : 'not_tested',
    checkedAt,
  };
}

function storeConnectionResult(success: boolean): void {
  localStorage.setItem(STORAGE_KEY_CONNECTION_STATUS, success ? 'passed' : 'failed');
  localStorage.setItem(STORAGE_KEY_CONNECTION_CHECKED_AT, new Date().toISOString());
  window.dispatchEvent(new Event(CONNECTION_STATUS_EVENT));
}

// ---------------------------------------------------------------------------
// Singleton Supabase client
// ---------------------------------------------------------------------------
let _cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (_cachedClient) return _cachedClient;

  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey || !url.startsWith('http')) return null;

  try {
    _cachedClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'vexalens_auth_session',
      },
    });
    return _cachedClient;
  } catch (err) {
    console.error('[VexaLens] Failed to initialize Supabase client:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection test (auth-aware)
// ---------------------------------------------------------------------------
export async function testSupabaseConnection(): Promise<{ success: boolean; message: string }> {
  const client = getSupabaseClient();
  if (!client) {
    storeConnectionResult(false);
    return { success: false, message: 'Supabase credentials not configured or invalid URL format' };
  }

  try {
    const { error } = await client.from('investigations').select('id').limit(1);
    if (error && error.code !== 'PGRST116') {
      if (error.message?.includes('relation "public.investigations" does not exist') ||
          error.message?.includes('does not exist in the schema cache')) {
        storeConnectionResult(true);
        return { success: true, message: 'Connected to Supabase! (Schema migration not yet run)' };
      }
      // RLS block = still connected, just not authenticated
      if (error.code === '42501' || error.message?.includes('row-level security')) {
        storeConnectionResult(true);
        return { success: true, message: 'Connected to Supabase (RLS active — sign in to load your data)' };
      }
      storeConnectionResult(false);
      return { success: false, message: error.message };
    }
    storeConnectionResult(true);
    return { success: true, message: 'Successfully connected and verified against Supabase PostgreSQL!' };
  } catch (err: any) {
    storeConnectionResult(false);
    return { success: false, message: err?.message || 'Connection test failed' };
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Returns the currently authenticated Supabase user, or null. */
export async function getAuthUser(): Promise<User | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const { data: sessionData } = await client.auth.getSession();
  const sessionUser = sessionData?.session?.user ?? null;

  try {
    const { data, error } = await client.auth.getUser();
    if (!error && data?.user) return data.user;
  } catch (error) {
    console.warn('[VexaLens] Supabase getUser temporarily unavailable; using the local session:', error);
  }

  return sessionUser;
}

/** Returns the current session. */
export async function getAuthSession(): Promise<Session | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data?.session ?? null;
}

/** Sign up with email + password. On success, upserts a profile row. */
export async function signUpWithEmail(
  email: string,
  password: string,
  profile: { fullName: string; badgeNumber?: string; agency?: string }
): Promise<{ user: User | null; error: AuthError | null }> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      user: null,
      error: { name: 'ClientError', message: 'Supabase not configured', status: 0 } as AuthError,
    };
  }

  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.user) return { user: null, error };

  // Upsert profile row
  await client.from('profiles').upsert({
    id: data.user.id,
    email: data.user.email!,
    full_name: profile.fullName || email.split('@')[0],
    badge_number: profile.badgeNumber || '',
    agency: profile.agency || 'VexaLens Forensics Lab',
    role: 'lead_analyst',
  });

  window.dispatchEvent(new Event(AUTH_STATE_EVENT));
  return { user: data.user, error: null };
}

/** Sign in with email + password. Ensures profile row exists. */
export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: User | null; session: Session | null; error: AuthError | null }> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      user: null,
      session: null,
      error: { name: 'ClientError', message: 'Supabase not configured', status: 0 } as AuthError,
    };
  }

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { user: null, session: null, error };

  // Ensure profile row exists for this user
  if (data.user) {
    const { data: existing } = await client
      .from('profiles')
      .select('id')
      .eq('id', data.user.id)
      .single();
    if (!existing) {
      await client.from('profiles').upsert({
        id: data.user.id,
        email: data.user.email!,
        full_name: data.user.email!.split('@')[0],
        badge_number: '',
        agency: 'VexaLens Forensics Lab',
        role: 'lead_analyst',
      });
    }
  }

  window.dispatchEvent(new Event(AUTH_STATE_EVENT));
  return { user: data.user, session: data.session, error: null };
}

/** Sign out the current user. */
export async function signOut(): Promise<{ error: AuthError | null }> {
  const client = getSupabaseClient();
  if (!client) return { error: null };
  const { error } = await client.auth.signOut();
  window.dispatchEvent(new Event(AUTH_STATE_EVENT));
  return { error };
}

/** Sends a password recovery email for the requested Supabase account. */
export async function requestPasswordReset(email: string): Promise<{ error: AuthError | null }> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      error: { name: 'ClientError', message: 'Supabase is not configured', status: 0 } as AuthError,
    };
  }

  const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: window.location.origin,
  });
  return { error };
}

/**
 * Load the profile for the authenticated user from Supabase.
 * Maps DB snake_case → app UserProfile camelCase.
 */
export async function loadProfile(userId: string): Promise<UserProfile | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const { data, error } = await client
    .from('profiles')
    .select('id, email, full_name, badge_number, agency, role, created_at')
    .eq('id', userId)
    .single();

  if (error) {
    console.error('[VexaLens] Failed to load authenticated profile:', error.message);
    return null;
  }
  if (!data) return null;

  return {
    id: data.id,
    email: data.email,
    fullName: data.full_name,
    badgeNumber: data.badge_number || '',
    agency: data.agency || '',
    role: (data.role as UserProfile['role']) || 'lead_analyst',
    createdAt: data.created_at,
  };
}

/**
 * Register a listener for Supabase auth state changes.
 * Returns the unsubscribe function.
 */
export function onAuthStateChange(
  callback: (event: string, session: Session | null) => void
): () => void {
  const client = getSupabaseClient();
  if (!client) return () => {};
  const { data } = client.auth.onAuthStateChange(callback);
  return () => data.subscription.unsubscribe();
}
