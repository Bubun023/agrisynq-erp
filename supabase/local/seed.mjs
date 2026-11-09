// Seeds the LOCAL dev stack with a demo company, three users and a little master data.
//   node supabase/local/seed.mjs      (or: bash supabase/local/stack.sh seed)
// Re-runnable: data is seeded once; missing users are (re)created.
// One login per role: admin@ branch@ accountant@ sales@ stock@ fms@ viewer@ fertiledger.test  -  password  Passw0rd#Local
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const API = "http://127.0.0.1:55321";
const PASSWORD = "Passw0rd#Local";
const env = Object.fromEntries(
  fs.readFileSync(new URL("../../.env.development.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const SERVICE = env.SUPABASE_SECRET_KEY;

function sql(text) {
  const r = spawnSync("docker", ["exec", "-i", "fl-local-db", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"],
    { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error("SQL failed:\n" + (r.stderr || r.stdout));
  return r.stdout.trim();
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const already = sql("select count(*) from tenants where slug = 'demo'") !== "0";

let tenantId, orgId;
function seedData() {
// chart of accounts: parsed from the app's own seed list so the two can never drift apart
const src = fs.readFileSync(new URL("../../src/actions/accounting.ts", import.meta.url), "utf8");
const accounts = [...src.matchAll(/\{\s*code:\s*'(\d+)',\s*name:\s*'([^']+)',\s*type:\s*'(\w+)',\s*group:\s*'([^']+)',\s*ctrl:\s*(?:'(\w+)'|null)\s*\}/g)]
  .map((m) => ({ code: m[1], name: m[2], type: m[3], group: m[4], ctrl: m[5] ?? null }));
if (accounts.length < 25) throw new Error(`only parsed ${accounts.length} accounts from accounting.ts - the seed list format changed`);

const ids = sql(`
  WITH t AS (INSERT INTO tenants (slug, name) VALUES ('demo', 'Demo Agro Traders') RETURNING id),
       o AS (INSERT INTO organisations (tenant_id, legal_name, trade_name, gstin, state_code, default_state, fy_start_month)
             SELECT id, 'Demo Agro Traders Pvt Ltd', 'Demo Agro', '27AABCD1234E1Z5', '27', 'Maharashtra', 4 FROM t RETURNING id, tenant_id)
  SELECT t.id || '|' || o.id FROM t, o;`).split("|");
[tenantId, orgId] = ids;
sql(`SELECT onboard_tenant('${tenantId}', 'Demo Agro Traders');`);

sql(`
  INSERT INTO chart_of_accounts (tenant_id, organisation_id, account_code, account_name, account_type, account_group, is_control_account, control_type, opening_balance, opening_balance_type, is_system)
  VALUES ${accounts.map((a) => `('${tenantId}','${orgId}',${q(a.code)},${q(a.name)},'${a.type}',${q(a.group)},${a.ctrl ? "true" : "false"},${a.ctrl ? q(a.ctrl) : "NULL"},0,'DR',true)`).join(",")};
  INSERT INTO locations (tenant_id, organisation_id, name, code, location_type) VALUES
    ('${tenantId}','${orgId}','Main Godown','MAIN','OWN'),
    ('${tenantId}','${orgId}','Pune C&F Depot','CNF-PUNE','CF_DEPOT');
  INSERT INTO parties (tenant_id, organisation_id, name, party_type, gstin, state_code, is_supplier, is_customer) VALUES
    ('${tenantId}','${orgId}','Kisan Fertilisers Ltd','SUPPLIER','27AAACK1111A1Z1','27',true,false),
    ('${tenantId}','${orgId}','Green Valley Retail','CUSTOMER','27AAACG2222B1Z2','27',false,true),
    ('${tenantId}','${orgId}','Sharma C&F Agency','CF_AGENT',NULL,'27',false,false);
  UPDATE locations SET custodian_party_id = (SELECT id FROM parties WHERE name = 'Sharma C&F Agency' AND tenant_id = '${tenantId}')
   WHERE name = 'Pune C&F Depot' AND tenant_id = '${tenantId}';
  INSERT INTO products (tenant_id, organisation_id, name, product_code, category, hsn_code, unit_of_measure, gst_rate, batch_required, expiry_required) VALUES
    ('${tenantId}','${orgId}','Urea 45kg','UREA45','FERTILIZER','3102','BAG',5,true,false),
    ('${tenantId}','${orgId}','DAP 50kg','DAP50','FERTILIZER','3105','BAG',5,true,false),
    ('${tenantId}','${orgId}','Hybrid Maize Seed 4kg','SEED-MZ4','SEED','1005','PKT',0,true,true),
    ('${tenantId}','${orgId}','Chlorpyrifos 1L','CHLOR1L','PESTICIDE','3808','BTL',18,true,true);
  INSERT INTO farmers (tenant_id, organisation_id, first_name, last_name, phone, village) VALUES
    ('${tenantId}','${orgId}','Ramesh','Patil','9876500001','Wagholi');
`);

}
if (already) { [tenantId, orgId] = sql("select t.id || '|' || o.id from tenants t join organisations o on o.tenant_id = t.id where t.slug = 'demo'").split('|'); } else { seedData(); }

async function createUser(email, fullName, role) {
  const res = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { tenant_id: tenantId, full_name: fullName } }),
  });
  if (!res.ok) throw new Error(`creating ${email} failed: ${res.status} ${await res.text()}`);
  const u = await res.json();
  sql(`INSERT INTO user_roles (tenant_id, user_id, role_id, organisation_id)
       SELECT '${tenantId}', '${u.id}', id, '${orgId}' FROM roles WHERE tenant_id = '${tenantId}' AND name = '${role}';`);
  const ok = sql(`select count(*) from user_profiles where id = '${u.id}'`);
  if (ok !== "1") throw new Error(`the signup trigger did not create a user_profile for ${email}`);
  return u.id;
}
const USERS = [
  ["admin@fertiledger.test", "Demo Admin", "SUPER_ADMIN"],
  ["branch@fertiledger.test", "Demo Branch Admin", "BRANCH_ADMIN"],
  ["accountant@fertiledger.test", "Demo Accountant", "ACCOUNTANT"],
  ["sales@fertiledger.test", "Demo Sales Manager", "SALES_MANAGER"],
  ["stock@fertiledger.test", "Demo Stock Manager", "STOCK_MANAGER"],
  ["fms@fertiledger.test", "Demo FMS Officer", "FMS_COMPLIANCE"],
  ["viewer@fertiledger.test", "Demo Viewer", "VIEWER"],
];
for (const [email, name, role] of USERS) {
  if (sql(`select count(*) from auth.users where email = '${email}'`) !== "0") continue;
  await createUser(email, name, role);
}

console.log(`demo tenant ${tenantId} ready. Logins (password ${PASSWORD}): ${USERS.map((u) => u[0]).join(', ')}`);
