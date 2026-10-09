import { createAdminClient } from '@/lib/supabase/admin';

export interface AuditEventParams {
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function logAuditEvent(params: AuditEventParams): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('audit_logs').insert({
      user_id: params.userId || null,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId || null,
      metadata: params.metadata || {},
      ip_address: params.ipAddress || null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Audit logging should not crash the primary transaction, but should report cleanly
    console.warn('Audit logging error:', err);
  }
}
