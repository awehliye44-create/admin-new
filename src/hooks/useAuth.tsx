import React, { useState, useEffect, useRef, createContext, useContext, ReactNode, useCallback } from 'react';
import { User, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isAdmin: boolean;
  isLoading: boolean;
  isAuthReady: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Events that indicate the user intentionally or definitively lost their session.
 * Only these cause a state reset to "logged out".
 */
const HARD_SIGNOUT_EVENTS: AuthChangeEvent[] = ['SIGNED_OUT'];

/**
 * Events where we accept the new session/user from Supabase.
 */
const SESSION_EVENTS: AuthChangeEvent[] = [
  'SIGNED_IN',
  'TOKEN_REFRESHED',
  'USER_UPDATED',
  'INITIAL_SESSION',
];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isAdmin, setIsAdmin] = useState(true); // Default true to avoid flash
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Track whether the user explicitly signed out to distinguish from spurious events
  const manualSignOut = useRef(false);
  // Cache admin status so transient failures don't flip it
  const adminCache = useRef<{ userId: string; isAdmin: boolean } | null>(null);

  const checkAdminRole = useCallback(async (userId: string): Promise<boolean> => {
    // Return cached value if we already know for this user
    if (adminCache.current?.userId === userId) {
      // Still re-check in background but return cached value immediately
      supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .eq('role', 'admin')
        .limit(1)
        .then(({ data, error }) => {
          if (!error) {
            const result = (data?.length ?? 0) > 0;
            adminCache.current = { userId, isAdmin: result };
            setIsAdmin(result);
          }
          // On error, keep cached value — don't flip to false
        });
      return adminCache.current.isAdmin;
    }

    // First-time check — must await
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .eq('role', 'admin')
        .limit(1);

      if (error) {
        console.error('Error checking admin role:', error);
        // On error, assume admin if we had a cached value, otherwise false
        return adminCache.current?.userId === userId ? adminCache.current.isAdmin : false;
      }

      const result = (data?.length ?? 0) > 0;
      adminCache.current = { userId, isAdmin: result };
      return result;
    } catch (err) {
      console.error('Error in checkAdminRole:', err);
      return adminCache.current?.userId === userId ? adminCache.current.isAdmin : false;
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    // 1. Bootstrap from persisted session (synchronous from localStorage)
    supabase.auth.getSession().then(async ({ data: { session: existingSession } }) => {
      if (!mounted) return;

      if (existingSession?.user) {
        setSession(existingSession);
        setUser(existingSession.user);
        const adminStatus = await checkAdminRole(existingSession.user.id);
        if (mounted) {
          setIsAdmin(adminStatus);
          setIsAuthReady(true);
        }
      } else {
        setSession(null);
        setUser(null);
        setIsAdmin(false);
        setIsAuthReady(true);
      }
    });

    // 2. Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, nextSession: Session | null) => {
        if (!mounted) return;

        console.log(`[Auth] Event: ${event}`, nextSession ? 'has session' : 'no session');

        // ── Hard sign-out: only on explicit SIGNED_OUT ──
        if (HARD_SIGNOUT_EVENTS.includes(event)) {
          // Only reset if it was a manual sign-out OR the session is truly gone
          if (manualSignOut.current || !nextSession) {
            setSession(null);
            setUser(null);
            setIsAdmin(false);
            adminCache.current = null;
            manualSignOut.current = false;

            // Show reason if it wasn't manual
            if (!manualSignOut.current && !nextSession) {
              toast.info('Session expired', {
                description: 'Your session has expired. Please sign in again.',
                duration: 8000,
              });
            }
          }
          return;
        }

        // ── Session events: accept new session data ──
        if (SESSION_EVENTS.includes(event) && nextSession?.user) {
          setSession(nextSession);
          setUser(nextSession.user);

          // Re-check admin role (uses cache for speed, refreshes in background)
          checkAdminRole(nextSession.user.id).then((result) => {
            if (mounted) setIsAdmin(result);
          });
          return;
        }

        // ── Unknown/other events: do nothing ──
        // Don't clear state on PASSWORD_RECOVERY, MFA_CHALLENGE_VERIFIED, etc.
      }
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [checkAdminRole]);

  const signIn = async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signUp = async (email: string, password: string) => {
    try {
      const redirectUrl = `${window.location.origin}/`;
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectUrl },
      });
      return { error };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signOut = async () => {
    manualSignOut.current = true;
    adminCache.current = null;
    await supabase.auth.signOut();
    // State will be cleared by the onAuthStateChange listener
  };

  return (
    <AuthContext.Provider value={{ user, session, isAdmin, isLoading, isAuthReady, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
