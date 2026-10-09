import { describe, it, expect } from 'vitest';
import { canManageConfiguration, canEvaluateDomain, hasDomainAccess, requireRole } from '../src/lib/auth/rbac';
import { UserProfile, UserRole } from '../src/types';

describe('Role-Based Access Control (RBAC)', () => {
  const superAdmin: UserProfile = {
    id: '1', email: 'admin@test.com', role: 'super_admin', assignedDomains: [], createdAt: '', updatedAt: ''
  };
  
  const evaluator: UserProfile = {
    id: '2', email: 'eval@test.com', role: 'domain_evaluator', assignedDomains: ['FinTech', 'HealthTech'], createdAt: '', updatedAt: ''
  };
  
  const observer: UserProfile = {
    id: '3', email: 'obs@test.com', role: 'read_only_observer', assignedDomains: ['EdTech'], createdAt: '', updatedAt: ''
  };

  it('super admin has access to manage configuration and all domains', () => {
    expect(canManageConfiguration(superAdmin)).toBe(true);
    expect(hasDomainAccess(superAdmin, 'AnyDomain')).toBe(true);
    expect(canEvaluateDomain(superAdmin, 'AnyDomain')).toBe(true);
    expect(requireRole(superAdmin, ['super_admin'])).toBe(true);
  });

  it('evaluator can only access and evaluate assigned domains', () => {
    expect(canManageConfiguration(evaluator)).toBe(false);
    expect(hasDomainAccess(evaluator, 'FinTech')).toBe(true);
    expect(hasDomainAccess(evaluator, 'Security')).toBe(false);
    expect(canEvaluateDomain(evaluator, 'HealthTech')).toBe(true);
    expect(canEvaluateDomain(evaluator, 'Security')).toBe(false);
    expect(requireRole(evaluator, ['domain_evaluator'])).toBe(true);
    expect(requireRole(evaluator, ['super_admin'])).toBe(false);
  });

  it('observer can access but cannot evaluate assigned domains', () => {
    expect(canManageConfiguration(observer)).toBe(false);
    expect(hasDomainAccess(observer, 'EdTech')).toBe(true);
    expect(hasDomainAccess(observer, 'FinTech')).toBe(false);
    expect(canEvaluateDomain(observer, 'EdTech')).toBe(false); // Observer cannot evaluate
  });

  it('handles null profiles safely', () => {
    expect(canManageConfiguration(null)).toBe(false);
    expect(hasDomainAccess(null, 'Domain')).toBe(false);
    expect(canEvaluateDomain(null, 'Domain')).toBe(false);
    expect(requireRole(null, ['super_admin'])).toBe(false);
  });
});
