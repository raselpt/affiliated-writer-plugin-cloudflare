export interface Env {
  DB: D1Database;
  PROMPTS: KVNamespace;
  R2: R2Bucket;
}

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const nowIso = () => new Date().toISOString();
const semverCmp = (a: string, b: string) => {
  const A = a.split(".").map(n => +n || 0), B = b.split(".").map(n => +n || 0);
  for (let i=0;i<Math.max(A.length,B.length);i++) { const d=(A[i]??0)-(B[i]??0); if (d) return d; }
  return 0;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ---- License activate ----
    if (url.pathname === "/v1/licenses/activate" && req.method === "POST") {
      const { key, site_url, site_hash, wp_version, plugin_version } = await req.json();
      const lic = await env.DB.prepare(
        "SELECT * FROM licenses WHERE key = ? AND status='active'"
      ).bind(key).first();
      if (!lic) return json(400, { ok:false, reason:"invalid_key" });
      if (lic.expires_at && new Date(lic.expires_at) < new Date()) return json(400, { ok:false, reason:"expired" });

      const existing = await env.DB.prepare(
        "SELECT * FROM activations WHERE license_id=? AND site_hash=? AND status='active'"
      ).bind(lic.id, site_hash).first();

      if (existing) {
        return json(200, { ok:true, license:{ plan:lic.plan, max_activations:lic.max_activations, expires_at:lic.expires_at }, activation_id: existing.id });
      }

      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM activations WHERE license_id=? AND status='active'"
      ).bind(lic.id).first() as any;
      if ((count?.c ?? 0) >= lic.max_activations) return json(409, { ok:false, reason:"limit_exceeded", max: lic.max_activations });

      const res = await env.DB.prepare(
        "INSERT INTO activations (license_id,site_url,site_hash,wp_version,plugin_version,activated_at,status) VALUES (?,?,?,?,?,?, 'active') RETURNING id"
      ).bind(lic.id, site_url, site_hash, wp_version ?? null, plugin_version ?? null, nowIso()).first();

      return json(200, { ok:true, license:{ plan:lic.plan, max_activations:lic.max_activations, expires_at:lic.expires_at }, activation_id: res?.id });
    }

    // ---- License deactivate ----
    if (url.pathname === "/v1/licenses/deactivate" && req.method === "POST") {
      const { key, site_hash } = await req.json();
      const lic = await env.DB.prepare("SELECT id FROM licenses WHERE key=?").bind(key).first();
      if (!lic) return json(400, { ok:false });
      await env.DB.prepare(
        "UPDATE activations SET status='revoked', deactivated_at=? WHERE license_id=? AND site_hash=? AND status='active'"
      ).bind(nowIso(), lic.id, site_hash).run();
      return json(200, { ok:true });
    }

    // ---- License validate ----
    if (url.pathname === "/v1/licenses/validate" && req.method === "GET") {
      const key = url.searchParams.get("key")!, site_hash = url.searchParams.get("site_hash")!, plugin_version = url.searchParams.get("plugin_version");
      const lic = await env.DB.prepare("SELECT * FROM licenses WHERE key=? AND status='active'").bind(key).first();
      if (!lic) return json(200, { valid:false, reason:"invalid_key" });
      if (lic.expires_at && new Date(lic.expires_at) < new Date()) return json(200, { valid:false, reason:"expired" });

      const act = await env.DB.prepare(
        "SELECT id FROM activations WHERE license_id=? AND site_hash=? AND status='active'"
      ).bind(lic.id, site_hash).first();
      if (!act) return json(200, { valid:false, reason:"not_activated" });

      await env.DB.prepare("UPDATE activations SET last_check_at=?, plugin_version=COALESCE(?, plugin_version) WHERE id=?")
        .bind(nowIso(), plugin_version, (act as any).id).run();

      return json(200, { valid:true, plan: lic.plan, expires_at: lic.expires_at });
    }

    // ---- Fetch prompts/logic (KV) ----
    if (url.pathname === "/v1/prompts" && req.method === "GET") {
      const section = url.searchParams.get("section") || "common";
      const version = url.searchParams.get("version") || "v1";
      const key = `prompts:${version}:${section}`;
      const val = await env.PROMPTS.get(key, "json");
      return json(200, { section, version, data: val ?? [] });
    }

    // ---- Updates: check & download ----
    if (url.pathname === "/v1/updates/check" && req.method === "GET") {
      const slug = url.searchParams.get("slug")!, version = url.searchParams.get("version")!, key = url.searchParams.get("key")!, site_hash = url.searchParams.get("site_hash")!;

      const lic = await env.DB.prepare("SELECT * FROM licenses WHERE key=? AND status='active'").bind(key).first();
      if (!lic || (lic.expires_at && new Date(lic.expires_at) < new Date())) return json(200, { has_update:false });

      const act = await env.DB.prepare("SELECT 1 FROM activations WHERE license_id=? AND site_hash=? AND status='active'")
        .bind(lic.id, site_hash).first();
      if (!act) return json(200, { has_update:false });

      const rel = await env.DB.prepare(
        "SELECT * FROM releases WHERE slug=? ORDER BY created_at DESC LIMIT 1"
      ).bind(slug).first();
      if (!rel || semverCmp(rel.version, version) <= 0) return json(200, { has_update:false });

      const tok = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO update_tokens (id,slug,version,license_id,site_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(tok, rel.slug, rel.version, lic.id, site_hash, new Date(Date.now()+15*60*1000).toISOString(), nowIso()).run();

      const dl = new URL("/v1/updates/download", req.url); dl.searchParams.set("token", tok);
      return json(200, { has_update:true, new_version: rel.version, download_url: dl.toString(), changelog: rel.changelog, signature: rel.signature });
    }

    if (url.pathname === "/v1/updates/download" && req.method === "GET") {
      const token = url.searchParams.get("token")!;
      const tok = await env.DB.prepare("SELECT * FROM update_tokens WHERE id=?").bind(token).first();
      if (!tok || new Date(tok.expires_at) < new Date()) return new Response("token expired", { status: 403 });
      const rel = await env.DB.prepare("SELECT * FROM releases WHERE slug=? AND version=?").bind(tok.slug, tok.version).first();
      // releases.key_path: R2 অবজেক্ট কী; যদি zip_url স্টোর করো, সেক্ষেত্রে fetch করে রিডাইরেক্ট দিতে পারো
      const keyPath = rel.key_path || rel.zip_url;
      const obj = await env.R2.get(keyPath);
      if (!obj) return new Response("file not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "application/zip",
          "content-disposition": `attachment; filename="${tok.slug.split('/').pop()}-${tok.version}.zip"`
        }
      });
    }

    if (url.pathname === "/api/health") return json(200, { ok: true });
    return json(404, { error: "not_found" });
  }
} satisfies ExportedHandler<Env>;
