import { createContext, useContext } from 'react';
import type { User } from '@supabase/supabase-js';

interface AuthContextType {
  user: User | null;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
