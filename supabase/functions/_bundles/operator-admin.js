// GENERATED FILE — do not edit by hand.
// Source: supabase/functions/operator-admin/index.ts (plus its imports from supabase/functions/_shared).
// Regenerate with: node scripts/build-operator-bundles.mjs
// supabase/functions/_shared/supabase.ts
var SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
var SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
var QueryBuilder = class {
  constructor(table) {
    this.table = table;
  }
  table;
  method = "GET";
  selectCols = "*";
  wantCount = false;
  singleRow = false;
  patchBody = null;
  filters = [];
  select(columns = "*", opts) {
    this.selectCols = columns;
    this.wantCount = opts?.count === "exact";
    if (opts?.head) this.method = "HEAD";
    return this;
  }
  update(values) {
    this.method = "PATCH";
    this.patchBody = values;
    return this;
  }
  eq(column, value) {
    this.filters.push([column, `eq.${value}`]);
    return this;
  }
  in(column, values) {
    const encoded = values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",");
    this.filters.push([column, `in.(${encoded})`]);
    return this;
  }
  is(column, value) {
    this.filters.push([column, `is.${String(value)}`]);
    return this;
  }
  lt(column, value) {
    this.filters.push([column, `lt.${value}`]);
    return this;
  }
  order(column, opts) {
    const dir = opts?.ascending === false ? "desc" : "asc";
    const nulls = opts?.nullsFirst === false ? ".nullslast" : opts?.nullsFirst === true ? ".nullsfirst" : "";
    this.filters.push(["order", `${column}.${dir}${nulls}`]);
    return this;
  }
  limit(n) {
    this.filters.push(["limit", String(n)]);
    return this;
  }
  single() {
    this.singleRow = true;
    return this;
  }
  async execute() {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${this.table}`);
    if (this.method !== "PATCH") {
      url.searchParams.set("select", this.selectCols);
    }
    for (const [k, v] of this.filters) {
      url.searchParams.append(k, v);
    }
    const prefer = [];
    if (this.wantCount) prefer.push("count=exact");
    if (this.method === "PATCH") prefer.push("return=minimal");
    const headers = {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "x-application-name": "hallyu-edge",
      Accept: this.singleRow ? "application/vnd.pgrst.object+json" : "application/json"
    };
    if (prefer.length > 0) headers.Prefer = prefer.join(",");
    if (this.patchBody !== null) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: this.method,
      headers,
      body: this.patchBody !== null ? JSON.stringify(this.patchBody) : void 0
    });
    const contentRange = res.headers.get("content-range");
    let count = null;
    if (contentRange && contentRange.includes("/")) {
      const parsed = Number(contentRange.split("/")[1]);
      if (Number.isFinite(parsed)) count = parsed;
    }
    if (!res.ok) {
      const text2 = await res.text().catch(() => "");
      return { data: null, count, error: { message: text2.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
    }
    if (this.method === "HEAD" || res.status === 204) {
      return { data: null, count, error: null };
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { data, count, error: null };
  }
  then(onfulfilled, onrejected) {
    return this.execute().then(onfulfilled, onrejected);
  }
};
function adminClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as function secrets");
  }
  return {
    async rpc(fn, params = {}) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "x-application-name": "hallyu-edge"
        },
        body: JSON.stringify(params)
      });
      if (!res.ok) {
        const text2 = await res.text().catch(() => "");
        return { data: null, error: { message: text2.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
      }
      const text = await res.text();
      return { data: text ? JSON.parse(text) : null, error: null };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table) {
      return new QueryBuilder(table);
    },
    storage: {
      from(bucket) {
        return {
          async remove(paths) {
            const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}`, {
              method: "DELETE",
              headers: {
                "Content-Type": "application/json",
                apikey: SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
                "x-application-name": "hallyu-edge"
              },
              body: JSON.stringify({ prefixes: paths })
            });
            if (!res.ok) {
              const text2 = await res.text().catch(() => "");
              return { data: null, error: { message: text2.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
            }
            const text = await res.text();
            return { data: text ? JSON.parse(text) : [], error: null };
          }
        };
      }
    }
  };
}

// supabase/functions/_shared/cors.ts
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// supabase/functions/operator-admin/index.ts
var SUPABASE_URL2 = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
var SERVICE_ROLE_KEY2 = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
async function resolveCaller(token) {
  const userResponse = await fetch(`${SUPABASE_URL2}/auth/v1/user`, {
    headers: { apikey: SERVICE_ROLE_KEY2, Authorization: `Bearer ${token}` }
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json().catch(() => null);
  if (!user?.id) return null;
  const admin = adminClient();
  const profile = await admin.from("profiles").select("id,role,handle,display_name,account_status").eq("auth_sub", user.id).limit(1);
  const row = asArray(profile.data)[0];
  if (!row || row.account_status !== "active") return null;
  if (row.role !== "admin" && row.role !== "ceo") return null;
  return {
    profileId: String(row.id),
    role: String(row.role),
    handle: String(row.handle ?? ""),
    displayName: String(row.display_name ?? "")
  };
}
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("POST only", 405);
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return errorResponse("authorization required", 401);
  const caller = await resolveCaller(token);
  if (!caller) return errorResponse("admin access required", 403);
  let body = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return errorResponse("invalid JSON body", 400);
  }
  const action = String(body.action ?? "");
  const admin = adminClient();
  try {
    switch (action) {
      case "overview": {
        const [analytics, providers, workers, tasks, approvals] = await Promise.all([
          admin.rpc("operator_platform_analytics", {}),
          admin.from("operator_provider").select("provider,label,model_id,enabled,is_default,health,last_ok_at,last_error_at,last_error_code,rpm_limit"),
          admin.from("operator_worker_health").select("worker_id,last_seen_at,version,tasks_processed,last_error").order("last_seen_at", { ascending: false }).limit(5),
          admin.from("operator_task").select("status").limit(5e3),
          admin.from("operator_approval").select("id,status").eq("status", "pending")
        ]);
        const counts = {};
        for (const row of asArray(tasks.data)) {
          const key = String(row.status ?? "unknown");
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return jsonResponse({
          analytics: analytics.data ?? null,
          providers: providers.data ?? [],
          workers: workers.data ?? [],
          task_counts: counts,
          pending_approvals: asArray(approvals.data).length,
          caller
        });
      }
      case "conversations": {
        const result = await admin.from("operator_conversation").select("id,channel,member_profile_id,external_thread_id,subject,status,last_inbound_at,last_outbound_at,created_at").order("last_inbound_at", { ascending: false, nullsFirst: false }).limit(60);
        return jsonResponse({ conversations: result.data ?? [] });
      }
      case "conversation": {
        const conversationId = String(body.conversation_id ?? "");
        if (!conversationId) return errorResponse("conversation_id required", 400);
        const context = await admin.rpc("operator_conversation_context", { p_conversation: conversationId, p_limit: 60 });
        const messages = await admin.from("operator_message").select("id,direction,author_type,author_profile_id,body,delivery_status,created_at").eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(100);
        return jsonResponse({ context: context.data ?? null, messages: messages.data ?? [] });
      }
      case "admin_message": {
        const text = String(body.body ?? "").trim();
        if (!text) return errorResponse("body required", 400);
        const conversationId = body.conversation_id ? String(body.conversation_id) : String(
          (await admin.rpc("operator_ensure_conversation", {
            p_channel: "admin_control",
            p_member: caller.profileId,
            p_thread: null,
            p_subject: "Admin control"
          })).data ?? ""
        );
        if (!conversationId) return errorResponse("could not open admin conversation", 500);
        const inserted = await fetch(`${SUPABASE_URL2}/rest/v1/operator_message`, {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY2,
            Authorization: `Bearer ${SERVICE_ROLE_KEY2}`,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            direction: "inbound",
            author_profile_id: caller.profileId,
            author_type: "admin",
            body: text.slice(0, 4e3),
            delivery_status: "delivered"
          })
        });
        if (!inserted.ok) return errorResponse("could not record message", 500);
        const task = await admin.rpc("operator_create_task", {
          p_task_type: "admin_command",
          p_input: { instruction: text.slice(0, 4e3), conversation_id: conversationId },
          p_conversation: conversationId,
          p_requester: caller.profileId,
          p_destination_type: "operator_conversation",
          p_destination_id: conversationId,
          p_idempotency_key: `admin:${caller.profileId}:${Date.now()}`,
          p_priority: 2,
          p_source_event: null
        });
        if (task.error) return errorResponse(`could not queue command: ${task.error.message}`, 500);
        return jsonResponse({ ok: true, conversation_id: conversationId, task_id: task.data });
      }
      case "tasks": {
        const status = body.status ? String(body.status) : "";
        let query = admin.from("operator_task").select("id,task_type,status,priority,attempt_count,max_attempts,error_code,error_detail,provider,model,created_at,updated_at,available_at,finished_at").order("created_at", { ascending: false }).limit(Math.min(Math.max(Number(body.limit ?? 40), 1), 100));
        if (status) query = query.eq("status", status);
        const result = await query;
        return jsonResponse({ tasks: result.data ?? [] });
      }
      case "task_retry": {
        const taskId = String(body.task_id ?? "");
        if (!taskId) return errorResponse("task_id required", 400);
        const patched = await admin.from("operator_task").update({
          status: "queued",
          available_at: (/* @__PURE__ */ new Date()).toISOString(),
          error_code: null,
          error_detail: null,
          lease_owner: null,
          lease_expires_at: null
        }).eq("id", taskId);
        if (patched.error) return errorResponse(patched.error.message, 500);
        const verify = await admin.from("operator_task").select("id,status").eq("id", taskId).limit(1);
        const row = asArray(verify.data)[0];
        if (!row || row.status !== "queued") return errorResponse("task was not re-queued", 409);
        return jsonResponse({ ok: true, task: row });
      }
      case "approvals": {
        const result = await admin.from("operator_approval").select("id,task_id,action,requested_by,required_role,status,decided_by,decided_at,note,payload,created_at").order("created_at", { ascending: false }).limit(60);
        return jsonResponse({ approvals: result.data ?? [] });
      }
      case "approval_decide": {
        const approvalId = String(body.approval_id ?? "");
        const decision = String(body.decision ?? "");
        if (!approvalId || !["approved", "rejected"].includes(decision)) {
          return errorResponse("approval_id and decision (approved|rejected) required", 400);
        }
        const rpcResponse = await fetch(`${SUPABASE_URL2}/rest/v1/rpc/operator_decide_approval`, {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY2,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            p_approval: approvalId,
            p_decision: decision,
            p_note: body.note ? String(body.note).slice(0, 500) : null
          })
        });
        const rpcText = await rpcResponse.text().catch(() => "");
        if (!rpcResponse.ok) return errorResponse(rpcText.slice(0, 300) || "approval decision failed", 500);
        return jsonResponse({ ok: true, result: rpcText ? JSON.parse(rpcText) : null });
      }
      case "providers": {
        const result = await admin.from("operator_provider").select("provider,label,model_id,base_url,enabled,is_default,health,last_ok_at,last_error_at,last_error_code,last_error_detail,rpm_limit,notes,updated_at");
        const usage = await admin.from("operator_provider_usage").select("provider,outcome,input_tokens,output_tokens,total_tokens,latency_ms,created_at").order("created_at", { ascending: false }).limit(200);
        return jsonResponse({ providers: result.data ?? [], recent_usage: usage.data ?? [] });
      }
      case "tools": {
        const result = await admin.from("operator_tool").select("name,description,family,permission,read_only,approval_required,rate_limit_per_min,timeout_ms,enabled").order("family", { ascending: true });
        return jsonResponse({ tools: result.data ?? [] });
      }
      case "moderation": {
        const queue = await admin.rpc("operator_moderation_queue", { p_limit: 50 });
        const cases = await admin.from("operator_moderation_case").select("id,target_type,target_id,rule_code,rule_text,confidence,decision,action_taken,appeal_status,created_at").order("created_at", { ascending: false }).limit(50);
        return jsonResponse({ queue: queue.data ?? [], cases: cases.data ?? [] });
      }
      case "research": {
        const result = await admin.from("operator_research_item").select("id,topic,headline,summary,source_name,source_url,verification,world,used_in_post_id,created_at").order("created_at", { ascending: false }).limit(60);
        return jsonResponse({ research: result.data ?? [] });
      }
      case "campaigns": {
        const result = await admin.from("operator_campaign").select("id,name,kind,status,starts_at,ends_at,payload,post_id,created_at").order("created_at", { ascending: false }).limit(60);
        return jsonResponse({ campaigns: result.data ?? [] });
      }
      case "schedules": {
        const result = await admin.from("operator_schedule").select("name,task_type,cadence_seconds,enabled,last_run_at,next_run_at,input,priority").order("name", { ascending: true });
        return jsonResponse({ schedules: result.data ?? [] });
      }
      case "audit": {
        const result = await admin.from("operator_audit").select("id,task_id,actor_profile_id,actor_type,action,outcome,resource_type,resource_id,details,created_at").order("created_at", { ascending: false }).limit(80);
        return jsonResponse({ audit: result.data ?? [] });
      }
      case "policy": {
        const result = await admin.from("operator_policy").select("autonomy,moderation,notifications,providers,approval_required,updated_at,updated_by").limit(1);
        return jsonResponse({ policy: asArray(result.data)[0] ?? null });
      }
      case "policy_update": {
        const patch = {};
        for (const key of ["autonomy", "moderation", "notifications", "providers"]) {
          if (body[key] && typeof body[key] === "object") patch[key] = body[key];
        }
        if (Object.keys(patch).length === 0) return errorResponse("nothing to update", 400);
        patch.updated_at = (/* @__PURE__ */ new Date()).toISOString();
        patch.updated_by = caller.profileId;
        const result = await admin.from("operator_policy").update(patch).eq("id", true);
        if (result.error) return errorResponse(result.error.message, 500);
        await admin.rpc("operator_audit_write", {
          p_action: "policy.updated",
          p_outcome: "ok",
          p_actor: caller.profileId,
          p_actor_type: "admin",
          p_resource_type: "operator_policy",
          p_resource_id: "singleton",
          p_details: { keys: Object.keys(patch) }
        });
        return jsonResponse({ ok: true });
      }
      case "health": {
        const [providers, workers, tasks] = await Promise.all([
          admin.from("operator_provider").select("provider,label,model_id,enabled,is_default,health,last_ok_at,last_error_at,last_error_code,rpm_limit"),
          admin.from("operator_worker_health").select("worker_id,last_seen_at,version,tasks_processed,last_error").order("last_seen_at", { ascending: false }).limit(5),
          admin.from("operator_task").select("status").limit(5e3)
        ]);
        const counts = {};
        for (const row of asArray(tasks.data)) {
          const key = String(row.status ?? "unknown");
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return jsonResponse({ providers: providers.data ?? [], workers: workers.data ?? [], task_counts: counts });
      }
      default:
        return errorResponse(`unknown action: ${action || "(none)"}`, 400);
    }
  } catch (error) {
    return errorResponse(error.message.slice(0, 400), 500);
  }
});
