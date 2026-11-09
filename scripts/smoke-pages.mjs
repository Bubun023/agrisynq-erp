// Page smoke test: logs in against the LOCAL dev stack, then requests every dashboard page with the real session
// cookie and reports pages that fail to render. Run with the dev server up:
//   node scripts/smoke-pages.mjs [--user viewer@fertiledger.test] [--base http://localhost:3000] [--only "^/fms"  (regex on the route)]
// It catches server-side failures (thrown errors, missing columns/relations in queries, crashes). It cannot judge
// layout or click-paths - treat a clean run as "nothing is broken on load", not "everything works".
import fs from "node:fs";
import path from "node:path";

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const BASE = arg("base", "http://localhost:3000");
const USER = arg("user", "admin@fertiledger.test");
const ONLY = arg("only", "");
const GREP = arg("grep", "");   // print text around a match in every page body, e.g. --grep "could not be loaded"
const PASSWORD = "Passw0rd#Local";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env.development.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const API = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ── log in and build the cookie @supabase/ssr 0.5 expects ──
const res = await fetch(`${API}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: USER, password: PASSWORD }),
});
if (!res.ok) { console.error("login failed:", res.status, await res.text()); process.exit(2); }
const session = await res.json();
const key = `sb-${new URL(API).hostname.split(".")[0]}-auth-token`;
const encoded = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
const CHUNK = 3180;
const cookie = encoded.length <= CHUNK ? `${key}=${encoded}`
  : Array.from({ length: Math.ceil(encoded.length / CHUNK) }, (_, i) => `${key}.${i}=${encoded.slice(i * CHUNK, (i + 1) * CHUNK)}`).join("; ");

// ── every dashboard route, from the file system (so new pages are covered automatically) ──
function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), base + "/" + e.name));
    else if (e.name === "page.tsx") out.push(base || "/");
  }
  return out;
}
const root = new URL("../src/app/(dashboard)", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const routes = walk(decodeURIComponent(root)).filter((r) => !r.includes("[")).filter((r) => !ONLY || new RegExp(ONLY).test(r)).sort();

const BAD = /Application error|Internal Server Error|Unhandled Runtime Error|Server Error|__next_error__|could not be loaded|NEXT_REDIRECT/i;
const results = [];
for (const route of routes) {
  const t0 = Date.now();
  let status = 0, note = "";
  try {
    const r = await fetch(BASE + route, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(180000) });
    status = r.status;
    if (status >= 300 && status < 400) note = "→ " + (r.headers.get("location") ?? "?");
    else {
      const body = await r.text();
      if (GREP) { const g = body.match(new RegExp(GREP, "i")); if (g) console.log("      >> " + body.slice(Math.max(0, g.index - 20), g.index + 260).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")); }
      const m = body.match(BAD);
      if (m) note = "page shows: " + m[0];
      else if (status === 200 && !/<html/i.test(body)) note = "no html";
    }
  } catch (e) { note = "request failed: " + (e instanceof Error ? e.message : e); }
  const ok = (status === 200 && !note) || (status >= 300 && status < 400 && note.includes("/logistics/") );
  results.push({ route, status, ok, note, ms: Date.now() - t0 });
  console.log(`${ok ? "ok  " : "FAIL"} ${String(status).padEnd(3)} ${String(Date.now() - t0).padStart(6)}ms  ${route} ${note}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pages loaded cleanly as ${USER}`);
process.exit(failed.length ? 1 : 0);
