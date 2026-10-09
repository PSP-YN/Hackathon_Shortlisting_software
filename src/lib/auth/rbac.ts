import { UserRole, UserProfile } from '@/types';
import { createClient } from '@/lib/supabase/server';

export async function getCurrentUserProfile(): Promise<UserProfile | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      // Fallback profile if row hasn't synced yet
      return {
        id: user.id,
        email: user.email || '',
        role: 'read_only_observer',
        assignedDomains: [],
        createdAt: user.created_at || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role as UserRole,
      assignedDomains: profile.assigned_domains || [],
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    };
  } catch (err) {
    console.error('Failed to get current user profile:', err);
    return null;
  }
}

export function hasDomainAccess(profile: UserProfile | null, domain: string): boolean {
  if (!profile) return false;
  if (profile.role === 'super_admin') return true;
  return profile.assignedDomains.includes(domain);
}

export function canManageConfiguration(profile: UserProfile | null): boolean {
  return profile?.role === 'super_admin';
}

export function canEvaluateDomain(profile: UserProfile | null, domain: string): boolean {
  if (!profile) return false;
  if (profile.role === 'super_admin') return true;
  if (profile.role === 'domain_evaluator' && profile.assignedDomains.includes(domain)) {
    return true;
  }
  return false;
}

export function canManageQueue(profile: UserProfile | null): boolean {
  return profile?.role === 'super_admin';
}

export function requireRole(profile: UserProfile | null, allowedRoles: UserRole[]): boolean {
  if (!profile) return false;
  return allowedRoles.includes(profile.role);
}

export function isSuperAdmin(profile: UserProfile | null): boolean {
  return profile?.role === 'super_admin';
}
