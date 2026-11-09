-- Business decision: the ACCOUNTANT may post sales invoices (and credit notes, which share the sales.post permission).
CREATE OR REPLACE FUNCTION public.apply_default_permission_extras(p_tenant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT rb.id, rp.permission_id
    FROM roles rb
    JOIN roles rs ON rs.tenant_id = rb.tenant_id AND rs.name = 'SUPER_ADMIN'
    JOIN role_permissions rp ON rp.role_id = rs.id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE rb.tenant_id = p_tenant_id AND rb.name = 'BRANCH_ADMIN'
     AND p.module NOT IN ('admin_users', 'admin_periods', 'audit_log', 'farmer_kyc_sensitive')
     AND NOT (p.module = 'master_data' AND p.action = 'delete')
  ON CONFLICT DO NOTHING;

  -- ACCOUNTANT books supplier invoices and posts sales invoices
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT ra.id, p.id FROM roles ra, permissions p
   WHERE ra.tenant_id = p_tenant_id AND ra.name = 'ACCOUNTANT'
     AND ((p.module = 'purchases' AND p.action IN ('create', 'post')) OR (p.module = 'sales' AND p.action = 'post'))
  ON CONFLICT DO NOTHING;
END $$;

SELECT public.apply_default_permission_extras(id) FROM tenants;
