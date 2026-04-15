"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import AuthModal from "@/components/AuthModal";

// ---- Context shape ----

interface AuthContextValue {
  /** Currently signed-in user, or null for a guest. */
  user: User | null;
  /** True while the initial session check is in-flight. */
  loading: boolean;
  /** Sign the current user out. */
  signOut: () => Promise<void>;
  /** Open the sign-in modal (no-op if already signed in). */
  openAuthModal: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  signOut: async () => {},
  openAuthModal: () => {},
});

// ---- Provider ----

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Hydrate from the existing session
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setLoading(false);
    });

    // Stay in sync with sign-in / sign-out events
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        // Close the modal on successful sign-in
        if (session?.user) setModalOpen(false);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
  }, []);

  const openAuthModal = useCallback(() => setModalOpen(true), []);

  return (
    <AuthContext.Provider value={{ user, loading, signOut, openAuthModal }}>
      {children}
      {modalOpen && <AuthModal onClose={() => setModalOpen(false)} />}
    </AuthContext.Provider>
  );
}

// ---- Hooks ----

/** Access auth state anywhere in the tree. */
export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Returns a wrapper that runs `callback` immediately if the user is signed in,
 * or opens the sign-in modal first if they are a guest.
 *
 * Usage:
 *   const requireAuth = useRequireAuth();
 *   <button onClick={() => requireAuth(() => saveData())}>Save</button>
 */
export function useRequireAuth() {
  const { user, openAuthModal } = useAuth();
  return useCallback(
    (callback: () => void) => {
      if (user) {
        callback();
      } else {
        openAuthModal();
      }
    },
    [user, openAuthModal]
  );
}
