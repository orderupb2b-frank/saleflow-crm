// SaleFlow CRM — Worker
// 靜態前端（index.html）照舊由 assets 提供；這支 Worker 只處理：
//   /oauth/*  給 ChatGPT「SaleFlow 助理」用的 OAuth 登入（沿用 Supabase 帳號）
//   /api/*    給 GPT Actions 呼叫的 API（用登入者本人的 Supabase token，RLS 照舊生效）
//   /openapi.json  GPT Actions 的規格檔
// 不需要 Supabase service_role key：所有資料存取都以「登入的那位業務」身分進行。

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Taipei
const BLOCKED_STAGES = ['結案', '簽約進件']; // 這兩個階段有後續流程（結案原因、轉客戶），只能在 CRM 裡操作
const INACTIVE_STAGES = ['結案', '暫停'];
const AI_TAG = '\n\n— 由 ChatGPT 助理記錄';
const ACTIVITY_TYPES = { email: 'Email', call: '電話/LINE', visit: '實體拜訪', event: '展覽活動', note: '內部備註' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
      if (p === '/openapi.json') return json(openapi(url.origin));
      if (p === '/oauth/authorize') return await authorize(request, env, url);
      if (p === '/oauth/token') return await token(request, env);
      if (p.startsWith('/api/')) return await api(request, env, url);
      if (p === '/privacy') return html(privacyPage());
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: '伺服器錯誤：' + (e.message || e) }, 500);
    }
  }
};

// ───────────────────────── helpers ─────────────────────────
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const cors = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS' });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() } });
const html = (s, status = 200) => new Response(s, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayTW = () => new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const toTW = iso => iso ? new Date(new Date(iso).getTime() + TZ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') : null;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
// "2026-10-12" / "2026-10-12 14:30" / "2026-10-12T14:30" (台北時間) → ISO
function twToISO(s) {
  if (!s) return new Date().toISOString();
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s).toISOString();
  const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) throw new HttpError(400, '時間格式要是 YYYY-MM-DD 或 YYYY-MM-DD HH:mm');
  const hh = (m[2] || '12').padStart(2, '0');
  return new Date(`${m[1]}T${hh}:${m[3] || '00'}:00+08:00`).toISOString();
}
async function readBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await request.json().catch(() => ({}));
  const fd = await request.formData().catch(() => null);
  return fd ? Object.fromEntries(fd) : {};
}

// Supabase REST（以使用者身分）
function sb(env, tokenStr) {
  const base = env.SUPABASE_URL;
  const headers = { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + tokenStr, 'Content-Type': 'application/json' };
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(base + '/rest/v1/' + path, { method, headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new HttpError(r.status === 401 ? 401 : 400, '資料庫錯誤：' + (data?.message || text));
    return data;
  };
  return {
    get: path => call('GET', path),
    insert: (table, row) => call('POST', table, row, { Prefer: 'return=representation' }).then(d => d?.[0]),
    update: (table, filter, row) => call('PATCH', `${table}?${filter}`, row, { Prefer: 'return=representation' })
  };
}
async function supabaseAuth(env, grant, body) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST', headers: { apikey: env.SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

// ───────────────────────── OAuth ─────────────────────────
// 流程：ChatGPT 導到 /oauth/authorize → 業務用 CRM 帳密登入 → 帶 code 回 ChatGPT
// code 本身就是 Supabase 的 refresh token（Supabase 會輪替、只能用一次），所以不需要另外存資料。
function validRedirect(u) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/aip\/[A-Za-z0-9_\-]+\/oauth\/callback$/.test(u || '');
}
function checkClient(env, id, secret) {
  if (env.OAUTH_CLIENT_ID && id !== env.OAUTH_CLIENT_ID) throw new HttpError(401, 'invalid_client');
  if (env.OAUTH_CLIENT_SECRET && secret !== env.OAUTH_CLIENT_SECRET) throw new HttpError(401, 'invalid_client');
}
async function authorize(request, env, url) {
  const q = request.method === 'POST' ? await readBody(request) : Object.fromEntries(url.searchParams);
  const { client_id, redirect_uri, state = '' } = q;
  if (!validRedirect(redirect_uri)) return html(loginPage(q, '這個登入連結不正確，請從 ChatGPT 的「SaleFlow 助理」重新登入。', true), 400);
  if (env.OAUTH_CLIENT_ID && client_id !== env.OAUTH_CLIENT_ID) return html(loginPage(q, 'client_id 不正確', true), 400);
  if (request.method !== 'POST') return html(loginPage(q));
  const { ok, data } = await supabaseAuth(env, 'password', { email: (q.email || '').trim(), password: q.password || '' });
  if (!ok) return html(loginPage(q, 'Email 或密碼錯誤，請再試一次（跟登入 SaleFlow CRM 的帳密一樣）'), 401);
  const to = new URL(redirect_uri);
  to.searchParams.set('code', data.refresh_token);
  if (state) to.searchParams.set('state', state);
  return Response.redirect(to.toString(), 302);
}
async function token(request, env) {
  const b = await readBody(request);
  let id = b.client_id, secret = b.client_secret;
  const basic = request.headers.get('authorization');
  if (basic?.startsWith('Basic ')) { const [i, s] = atob(basic.slice(6)).split(':'); id = decodeURIComponent(i); secret = decodeURIComponent(s || ''); }
  try { checkClient(env, id, secret); } catch { return json({ error: 'invalid_client' }, 401); }
  const rt = b.grant_type === 'authorization_code' ? b.code : b.grant_type === 'refresh_token' ? b.refresh_token : null;
  if (!rt) return json({ error: 'unsupported_grant_type' }, 400);
  const { ok, data } = await supabaseAuth(env, 'refresh_token', { refresh_token: rt });
  if (!ok) return json({ error: 'invalid_grant' }, 400);
  return json({ access_token: data.access_token, token_type: 'bearer', expires_in: data.expires_in || 3600, refresh_token: data.refresh_token });
}
function loginPage(q, err = '', fatal = false) {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'state', 'scope'].map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登入 SaleFlow 助理</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#f4f5f7;color:#1f2937;padding:16px}
.card{width:100%;max-width:380px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 6px}p{color:#6b7280;font-size:14px;margin:0 0 20px;line-height:1.6}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}input[type=email],input[type=password]{width:100%;padding:12px;border:1px solid #d1d5db;border-radius:10px;font-size:16px}
button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:16px;font-weight:600}
.err{background:#fef2f2;color:#b91c1c;padding:10px 12px;border-radius:10px;font-size:14px;margin-bottom:8px}
</style></head><body><div class="card"><h1>登入 SaleFlow 助理</h1>
<p>用你的 SaleFlow CRM 帳號登入，之後就能在 ChatGPT 裡直接查名單、記活動。</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
${fatal ? '' : `<form method="post" action="/oauth/authorize">${hidden}
<label>Email</label><input type="email" name="email" value="${esc(q.email)}" autocomplete="username" required>
<label>密碼</label><input type="password" name="password" autocomplete="current-password" required>
<button type="submit">登入並授權</button></form>`}
</div></body></html>`;
}
function privacyPage() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SaleFlow 助理 隱私說明</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.7">
<h1>SaleFlow 助理 隱私說明</h1><p>此 GPT 僅供奧德上股份有限公司內部業務使用。透過 ChatGPT 查詢或記錄的資料儲存在公司的 SaleFlow CRM，存取權限與 CRM 帳號相同。對話內容會經過 OpenAI 處理，建議在 ChatGPT 設定中關閉「為所有人改善模型」。</p></body>`;
}

// ───────────────────────── API ─────────────────────────
async function api(request, env, url) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, '尚未登入');
  const tk = auth.slice(7);
  const ur = await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + tk } });
  if (!ur.ok) throw new HttpError(401, '登入已過期，請重新登入');
  const user = await ur.json();
  const db = sb(env, tk);
  const prof = (await db.get(`user_profiles?id=eq.${user.id}&select=id,full_name,role,email`))?.[0];
  const me = { id: user.id, name: prof?.full_name || user.user_metadata?.full_name || user.email?.split('@')[0], role: prof?.role || 'sales', email: user.email };
  const ctx = { env, db, me, url, request };

  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  let mm;
  if (m === 'GET' && path === '/api/me') return json(await apiMe(ctx));
  if (m === 'GET' && path === '/api/leads') return json(await searchLeads(ctx));
  if (m === 'POST' && path === '/api/leads') return json(await createLead(ctx, await readBody(request)));
  if ((mm = path.match(/^\/api\/leads\/([0-9a-f-]{36})$/)) && m === 'GET') return json(await getLead(ctx, mm[1]));
  if ((mm = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/activities$/)) && m === 'POST') return json(await addActivity(ctx, mm[1], await readBody(request)));
  if ((mm = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/next-contact$/)) && m === 'PATCH') return json(await setNextContact(ctx, mm[1], await readBody(request)));
  if ((mm = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/stage$/)) && m === 'PATCH') return json(await setStage(ctx, mm[1], await readBody(request)));
  if (m === 'GET' && path === '/api/followups') return json(await followups(ctx));
  if (m === 'GET' && path === '/api/report/activity') return json(await activityReport(ctx));
  if (m === 'GET' && path === '/api/report/attention') return json(await attentionReport(ctx));
  if (m === 'GET' && path === '/api/customers') return json(await listCustomers(ctx));
  if ((mm = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/deals$/)) && m === 'GET') return json(await getDeals(ctx, mm[1]));
  if ((mm = path.match(/^\/api\/leads\/([0-9a-f-]{36})\/deals$/)) && m === 'POST') return json(await recordDeal(ctx, mm[1], await readBody(request)));
  if ((mm = path.match(/^\/api\/deals\/([0-9a-f-]{36})$/)) && m === 'PATCH') return json(await updateDeal(ctx, mm[1], await readBody(request)));
  if ((mm = path.match(/^\/api\/deals\/([0-9a-f-]{36})\/payments$/)) && m === 'POST') return json(await recordPayment(ctx, mm[1], await readBody(request)));
  throw new HttpError(404, '沒有這個功能');
}

async function lookups(db) {
  const [stages, users] = await Promise.all([
    db.get('stages?select=id,name,order_index&order=order_index'),
    db.get('user_profiles?select=id,full_name,role')
  ]);
  return {
    stages,
    stageName: id => stages.find(s => s.id === id)?.name || null,
    stageByName: n => stages.find(s => s.name === String(n || '').trim()),
    userName: id => users.find(u => u.id === id)?.full_name || null,
    userByName: n => users.find(u => u.full_name && (u.full_name === n || u.full_name.includes(n))),
    users
  };
}
function leadSummary(l, L) {
  return {
    id: l.id, name: l.name, tax_id: l.tax_id || null,
    stage: L.stageName(l.stage_id), owner: l.user_name || L.userName(l.user_id),
    next_contact_date: l.next_contact_date || null, last_updated: toTW(l.updated_at || l.created_at),
    crm_link: null
  };
}
const withLink = (o, origin) => ({ ...o, crm_link: origin + '/#lead=' + o.id });
async function loadLead(ctx, id) {
  const l = (await ctx.db.get(`leads?id=eq.${id}&select=*`))?.[0];
  if (!l) throw new HttpError(404, '找不到這筆名單（或你沒有權限看）');
  return l;
}

async function apiMe({ me, db }) {
  const L = await lookups(db);
  return {
    name: me.name, role: me.role === 'admin' ? '主管(admin)' : '業務(sales)', today: todayTW(), timezone: 'Asia/Taipei',
    stages: L.stages.map(s => s.name),
    gpt_cannot_set_stages: BLOCKED_STAGES,
    activity_types: ACTIVITY_TYPES,
    team: me.role === 'admin' ? L.users.map(u => ({ name: u.full_name, role: u.role })) : undefined
  };
}

async function searchLeads({ db, url }) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) throw new HttpError(400, '請提供 q（公司名、統編、聯絡人姓名或電話）');
  const pat = encodeURIComponent('*' + q.replace(/[*,()]/g, ' ').trim() + '*');
  const [L, byLead, byContact] = await Promise.all([
    lookups(db),
    db.get(`leads?select=id,name,tax_id,stage_id,user_id,user_name,next_contact_date,created_at,updated_at&or=(name.ilike.${pat},company.ilike.${pat},tax_id.ilike.${pat})&limit=10`),
    db.get(`contacts?select=name,role,lead_id&or=(name.ilike.${pat},phone.ilike.${pat},email.ilike.${pat})&limit=10`)
  ]);
  const ids = new Set(byLead.map(l => l.id));
  const extra = byContact.map(c => c.lead_id).filter(id => id && !ids.has(id));
  let more = [];
  if (extra.length) more = await db.get(`leads?select=id,name,tax_id,stage_id,user_id,user_name,next_contact_date,created_at,updated_at&id=in.(${[...new Set(extra)].join(',')})`);
  const results = [...byLead, ...more].map(l => {
    const o = withLink(leadSummary(l, L), url.origin);
    const cs = byContact.filter(c => c.lead_id === l.id);
    if (cs.length) o.matched_contacts = cs.map(c => c.name + (c.role ? `（${c.role}）` : ''));
    return o;
  });
  return { query: q, count: results.length, results, hint: results.length ? undefined : '查無資料。可以換關鍵字（簡稱、統編、聯絡人），或確認後用 createLead 新增。' };
}

async function getLead({ db, url }, id) {
  const [L, l, contacts, acts] = await Promise.all([
    lookups(db), loadLead({ db }, id),
    db.get(`contacts?lead_id=eq.${id}&select=id,name,role,phone,email,line_id`),
    db.get(`activities?lead_id=eq.${id}&select=type,content,created_at,user_id,contact_id&order=created_at.desc&limit=15`)
  ]);
  const extra = {};
  for (const k of ['product_type', 'amount', 'need_types', 'lost_reason']) if (l[k] != null && l[k] !== '') extra[k] = l[k];
  return {
    ...withLink(leadSummary(l, L), url.origin), ...extra,
    contacts: contacts.map(c => ({ name: c.name, title: c.role || null, phone: c.phone || null, email: c.email || null, line: c.line_id || null })),
    recent_activities: acts.map(a => ({
      when: toTW(a.created_at), type: ACTIVITY_TYPES[a.type] || a.type, by: L.userName(a.user_id),
      contact: contacts.find(c => c.id === a.contact_id)?.name || null, content: a.content
    }))
  };
}

async function addActivity({ db, me, url }, leadId, b) {
  const lead = await loadLead({ db }, leadId);
  const content = String(b.content || '').trim();
  if (!content) throw new HttpError(400, 'content 不能空白');
  const type = ACTIVITY_TYPES[b.type] ? b.type : 'visit';
  let contactId = null, contactNote = '';
  if (b.contact_name) {
    const cs = await db.get(`contacts?lead_id=eq.${leadId}&select=id,name`);
    const hit = cs.find(c => c.name === b.contact_name) || cs.find(c => c.name.includes(b.contact_name) || b.contact_name.includes(c.name));
    if (hit) contactId = hit.id; else contactNote = `（聯絡人「${b.contact_name}」不在這家的聯絡人名單中，已寫在內容裡，沒有連結）`;
  }
  const createdAt = twToISO(b.occurred_at);
  const act = await db.insert('activities', { type, content: content + AI_TAG, lead_id: leadId, contact_id: contactId, user_id: me.id, created_at: createdAt });

  // 下次聯絡日：跟 CRM 畫面的邏輯一樣
  const today = todayTW();
  const cur = lead.next_contact_date || '';
  let nx = cur;
  if (b.next_contact_date === 'none' || b.next_contact_date === null) nx = '';
  else if (isDate(b.next_contact_date)) nx = b.next_contact_date;
  else if (b.next_contact_date) throw new HttpError(400, 'next_contact_date 要是 YYYY-MM-DD 或 none');
  else if (cur && cur <= today) nx = ''; // 原本到期／逾期，這次聯絡過了 → 清掉
  const upd = { updated_at: new Date().toISOString() };
  if (nx !== cur) upd.next_contact_date = nx || null;
  await db.update('leads', `id=eq.${leadId}`, upd);
  return {
    ok: true, lead: lead.name, activity_id: act?.id, type: ACTIVITY_TYPES[type], when: toTW(createdAt),
    next_contact_date: nx || null, next_contact_changed: nx !== cur, note: contactNote || undefined,
    crm_link: url.origin + '/#lead=' + leadId
  };
}

async function setNextContact({ db, url }, leadId, b) {
  const lead = await loadLead({ db }, leadId);
  const d = b.date === 'none' || b.date === null ? null : b.date;
  if (d !== null && !isDate(d)) throw new HttpError(400, 'date 要是 YYYY-MM-DD 或 none');
  await db.update('leads', `id=eq.${leadId}`, { next_contact_date: d, updated_at: new Date().toISOString() });
  return { ok: true, lead: lead.name, previous: lead.next_contact_date || null, next_contact_date: d, crm_link: url.origin + '/#lead=' + leadId };
}

async function setStage({ db, url }, leadId, b) {
  const [L, lead] = await Promise.all([lookups(db), loadLead({ db }, leadId)]);
  const st = L.stageByName(b.stage);
  if (!st) throw new HttpError(400, `沒有「${b.stage}」這個階段。可用：${L.stages.map(s => s.name).join('、')}`);
  if (BLOCKED_STAGES.includes(st.name)) throw new HttpError(400, `「${st.name}」需要在 CRM 裡操作（要填結案原因或轉成客戶），請點連結處理：${url.origin}/#lead=${leadId}`);
  const prev = L.stageName(lead.stage_id);
  await db.update('leads', `id=eq.${leadId}`, { stage_id: st.id, updated_at: new Date().toISOString() });
  return { ok: true, lead: lead.name, from: prev, to: st.name, crm_link: url.origin + '/#lead=' + leadId };
}

async function createLead({ db, me, url }, b) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'name（公司名稱）必填');
  const tax = b.tax_id ? String(b.tax_id).trim() : null;
  if (tax && !/^\d{8}$/.test(tax)) throw new HttpError(400, '統一編號須為 8 碼數字');
  const L = await lookups(db);
  if (tax) {
    const dup = await db.get(`leads?tax_id=eq.${tax}&select=id,name`);
    if (dup.length) return { ok: false, duplicate: true, message: `統編 ${tax} 已存在於「${dup[0].name}」，沒有新增。`, existing: withLink({ id: dup[0].id, name: dup[0].name }, url.origin) };
  }
  if (!b.confirm_not_duplicate) {
    const core = name.replace(/(股份)?有限公司|企業社|工作室|商行|實業|國際/g, '').trim() || name;
    const sim = await db.get(`leads?name=ilike.${encodeURIComponent('*' + core + '*')}&select=id,name,user_name&limit=5`);
    if (sim.length) return { ok: false, possible_duplicates: sim.map(s => withLink({ id: s.id, name: s.name, owner: s.user_name }, url.origin)), message: '有名稱相近的名單，請跟使用者確認是不是同一家；確定是新的再帶 confirm_not_duplicate=true 重送。' };
  }
  const stage = (b.stage && L.stageByName(b.stage)) || L.stages[0];
  if (BLOCKED_STAGES.includes(stage.name)) throw new HttpError(400, `新名單不能直接放在「${stage.name}」`);
  const lead = await db.insert('leads', {
    name, tax_id: tax, stage_id: stage.id, product_type: b.product_type || null,
    user_id: me.id, user_name: me.name, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  if (b.contact_name) await db.insert('contacts', {
    name: b.contact_name, role: b.contact_title || null, phone: b.contact_phone || null, email: b.contact_email || null,
    lead_id: lead.id, user_id: me.id, created_at: new Date().toISOString()
  });
  return { ok: true, created: withLink({ id: lead.id, name, stage: stage.name, owner: me.name }, url.origin) };
}

// 我的待聯絡（主管可指定業務或看全部）
async function followups({ db, me, url }) {
  const L = await lookups(db);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '0', 10) || 0, 0), 30);
  const today = todayTW(), until = addDays(today, days);
  let filter = '';
  const who = url.searchParams.get('owner');
  if (me.role !== 'admin' || !who) filter = `&user_id=eq.${me.id}`;
  else if (who !== 'all') { const u = L.userByName(who); if (!u) throw new HttpError(400, `找不到業務「${who}」`); filter = `&user_id=eq.${u.id}`; }
  const rows = await db.get(`leads?select=id,name,tax_id,stage_id,user_id,user_name,next_contact_date,updated_at,created_at&next_contact_date=lte.${until}${filter}&order=next_contact_date&limit=200`);
  const items = rows.filter(l => !INACTIVE_STAGES.includes(L.stageName(l.stage_id))).map(l => ({
    ...withLink(leadSummary(l, L), url.origin),
    status: l.next_contact_date < today ? `逾期 ${Math.round((new Date(today) - new Date(l.next_contact_date)) / 864e5)} 天` : l.next_contact_date === today ? '今天' : '即將到期'
  }));
  return { today, through: until, count: items.length, overdue: items.filter(i => i.status.startsWith('逾期')).length, items };
}

// 活動報表：期間內誰做了什麼（業務只看得到自己）
async function activityReport({ db, me, url }) {
  const L = await lookups(db);
  const today = todayTW();
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(today, -6);
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
  let userFilter = '';
  const who = url.searchParams.get('owner');
  if (me.role !== 'admin') userFilter = `&user_id=eq.${me.id}`;
  else if (who && who !== 'all') { const u = L.userByName(who); if (!u) throw new HttpError(400, `找不到業務「${who}」`); userFilter = `&user_id=eq.${u.id}`; }
  const fromISO = new Date(from + 'T00:00:00+08:00').toISOString(), toISO = new Date(addDays(to, 1) + 'T00:00:00+08:00').toISOString();
  const acts = await db.get(`activities?select=type,content,created_at,user_id,lead_id&created_at=gte.${fromISO}&created_at=lt.${toISO}${userFilter}&order=created_at.desc&limit=500`);
  const leadIds = [...new Set(acts.map(a => a.lead_id).filter(Boolean))];
  const leads = leadIds.length ? await db.get(`leads?select=id,name,stage_id,next_contact_date&id=in.(${leadIds.join(',')})`) : [];
  const lead = id => leads.find(l => l.id === id);
  const byUser = {};
  for (const a of acts) {
    const n = L.userName(a.user_id) || '未知';
    const u = byUser[n] ||= { activities: 0, by_type: {}, companies: new Set() };
    u.activities++; u.by_type[ACTIVITY_TYPES[a.type] || a.type] = (u.by_type[ACTIVITY_TYPES[a.type] || a.type] || 0) + 1;
    if (a.lead_id) u.companies.add(lead(a.lead_id)?.name || a.lead_id);
  }
  return {
    period: `${from} ~ ${to}`, scope: me.role === 'admin' ? (who && who !== 'all' ? who : '全隊') : me.name,
    total_activities: acts.length, truncated: acts.length === 500,
    by_salesperson: Object.fromEntries(Object.entries(byUser).map(([k, v]) => [k, { activities: v.activities, by_type: v.by_type, companies_touched: v.companies.size, companies: [...v.companies] }])),
    activities: acts.slice(0, 200).map(a => ({
      when: toTW(a.created_at), by: L.userName(a.user_id), company: lead(a.lead_id)?.name || null,
      current_stage: L.stageName(lead(a.lead_id)?.stage_id), type: ACTIVITY_TYPES[a.type] || a.type,
      content: (a.content || '').replace(AI_TAG, '').slice(0, 300)
    }))
  };
}

// 需要關注：逾期未追 + 太久沒動的案子
async function attentionReport({ db, me, url }) {
  const L = await lookups(db);
  const stale = Math.min(Math.max(parseInt(url.searchParams.get('stale_days') || '30', 10) || 30, 7), 180);
  const today = todayTW();
  let filter = '';
  const who = url.searchParams.get('owner');
  if (me.role !== 'admin') filter = `&user_id=eq.${me.id}`;
  else if (who && who !== 'all') { const u = L.userByName(who); if (!u) throw new HttpError(400, `找不到業務「${who}」`); filter = `&user_id=eq.${u.id}`; }
  const staleISO = new Date(addDays(today, -stale) + 'T00:00:00+08:00').toISOString();
  const [overdue, idle] = await Promise.all([
    db.get(`leads?select=id,name,stage_id,user_id,user_name,next_contact_date,updated_at,created_at&next_contact_date=lt.${today}${filter}&order=next_contact_date&limit=200`),
    db.get(`leads?select=id,name,stage_id,user_id,user_name,next_contact_date,updated_at,created_at&updated_at=lt.${staleISO}${filter}&order=updated_at&limit=200`)
  ]);
  const active = l => !INACTIVE_STAGES.includes(L.stageName(l.stage_id)) && L.stageName(l.stage_id) !== '新名單';
  const byStage = {};
  for (const l of idle.filter(active)) (byStage[L.stageName(l.stage_id)] ||= []).push(l);
  return {
    today, scope: me.role === 'admin' ? (who && who !== 'all' ? who : '全隊') : me.name,
    overdue_followups: overdue.filter(l => !INACTIVE_STAGES.includes(L.stageName(l.stage_id))).map(l => ({ ...withLink(leadSummary(l, L), url.origin), days_overdue: Math.round((new Date(today) - new Date(l.next_contact_date)) / 864e5) })),
    stale_deals: { no_update_for_days: stale, by_stage: Object.fromEntries(Object.entries(byStage).map(([s, ls]) => [s, ls.map(l => withLink(leadSummary(l, L), url.origin))])) }
  };
}

// ───────────────────────── 成交單／收款 ─────────────────────────
const DEAL_CATS = ['主約', '加購專案', '客製案件', '續約', '其他'];
const num = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(/[^\d.-]/g, '')); return isNaN(n) ? null : n; };
const ctItems = c => (Array.isArray(c.items) && c.items.length) ? c.items : [{ name: c.name || '成交', amount: c.amount || 0 }];
const ctInst = c => (Array.isArray(c.installments) && c.installments.length) ? c.installments : [{ label: '全額', amount: c.amount || 0, due_date: c.signed_date, paid_date: null }];
const paidAmt = p => p.paid_date ? (p.paid_amount != null ? Number(p.paid_amount) || 0 : Number(p.amount) || 0) : 0;
function ctMonthly(c) {
  if (c.monthly_fee != null && c.monthly_fee !== '') return Number(c.monthly_fee) || 0;
  const mt = String(c.plan_content || '').match(/月費[：:]\s*(?:NT)?\$?\s*([\d,]+)/);
  return mt ? (parseInt(mt[1].replace(/,/g, ''), 10) || 0) : 0;
}
function finSummary(contracts) {
  const today = todayTW();
  let total = 0, paid = 0, monthly = 0, next = null, start = '', end = '';
  for (const c of contracts) {
    total += Number(c.amount) || ctItems(c).reduce((s, it) => s + (Number(it.amount) || 0), 0);
    for (const p of ctInst(c)) {
      paid += paidAmt(p);
      if (!p.paid_date && (!next || String(p.due_date || '') < String(next.due_date || ''))) next = { amount: Number(p.amount) || 0, due_date: p.due_date || null, label: p.label || '', overdue: !!(p.due_date && p.due_date < today) };
    }
    if (!c.end_date || c.end_date >= today) {
      monthly += ctMonthly(c);
      if (c.start_date && (!start || c.start_date < start)) start = c.start_date;
      if (c.end_date && (!end || c.end_date > end)) end = c.end_date;
    }
  }
  return { deals: contracts.length, total, paid, unpaid: Math.max(0, total - paid), monthly_fee: monthly, contract_start: start || null, contract_end: end || null, next_payment: next };
}
function dealView(c) {
  const inst = ctInst(c);
  return {
    deal_id: c.id, name: c.name, category: c.deal_category || '主約', signed_date: c.signed_date, start_date: c.start_date, end_date: c.end_date,
    monthly_fee: ctMonthly(c) || null, amount: Number(c.amount) || 0, paid: inst.reduce((s, p) => s + paidAmt(p), 0),
    items: ctItems(c).map(it => ({ name: it.name, amount: it.amount, bonus_type: it.bonus_type })),
    installments: inst.map((p, i) => ({ index: i, label: p.label, amount: p.amount, due_date: p.due_date, paid_date: p.paid_date || null, paid_amount: p.paid_date ? paidAmt(p) : null })),
    plan_content: c.plan_content ? String(c.plan_content).slice(0, 400) : null, note: c.note || null, sales: c.sales_user_name || null
  };
}
// 明細：type = subscription 訂閱/月費、setup 導入建置、addon 加購、custom 客製、gift 贈送
function normItems(list, cat) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'items 至少要一項（名稱＋未稅折後金額）');
  return list.map((it, i) => {
    const name = String(it.name || '').trim();
    const amount = num(it.amount);
    if (!name) throw new HttpError(400, `第 ${i + 1} 項缺少名稱`);
    if (amount == null || amount < 0) throw new HttpError(400, `「${name}」金額不正確（贈送請填 0）`);
    let bt = it.bonus_type;
    if (!['standard', 'custom', 'renewal', 'none'].includes(bt)) {
      const t = it.type || '';
      bt = amount === 0 || t === 'gift' ? 'none' : t === 'custom' ? 'custom' : (t === 'subscription' && cat === '續約') ? 'renewal' : 'standard';
    }
    return { name, amount, bonus_type: bt };
  });
}
function normInst(list, total, signed, isAdmin, notes) {
  let inst = Array.isArray(list) && list.length ? list : [{ label: '全額', amount: total, due_date: signed }];
  inst = inst.map((p, i) => {
    const o = { label: String(p.label || '').trim() || (inst.length === 1 ? '全額' : `第 ${i + 1} 期`), amount: num(p.amount) ?? 0, due_date: isDate(p.due_date) ? p.due_date : signed, alloc: p.alloc || 'prorata', paid_date: null };
    if (p.paid_date) {
      if (!isAdmin) notes.push(`「${o.label}」的收款需要管理員在 CRM 確認，先記為未收`);
      else if (!isDate(p.paid_date)) throw new HttpError(400, 'paid_date 要是 YYYY-MM-DD');
      else { o.paid_date = p.paid_date; o.paid_amount = num(p.paid_amount) ?? o.amount; o.paid_by = 'ChatGPT 助理'; o.paid_at = new Date().toISOString(); }
    }
    return o;
  });
  const sum = inst.reduce((s, p) => s + p.amount, 0);
  if (Math.abs(sum - total) > 0.5) throw new HttpError(400, `付款期數合計 ${sum} ≠ 明細合計 ${total}，請調整 installments`);
  return inst;
}
async function accountForLead(db, leadId) {
  return (await db.get(`accounts?lead_id=eq.${leadId}&select=*`))?.[0] || null;
}
async function getDeals({ db, url }, leadId) {
  const lead = await loadLead({ db }, leadId);
  const acc = await accountForLead(db, leadId);
  if (!acc) return { lead: lead.name, is_customer: false, message: '這家還不是成交客戶，沒有成交單。可用 record_deal 建立。', crm_link: url.origin + '/#lead=' + leadId };
  const cts = await db.get(`contracts?account_id=eq.${acc.id}&select=*&order=signed_date.desc`);
  return { lead: lead.name, is_customer: true, status: acc.status === 'terminated' ? '終止合作' : '合作中', summary: finSummary(cts), deals: cts.map(dealView), crm_link: url.origin + '/#lead=' + leadId };
}
async function recordDeal({ db, me, url }, leadId, b) {
  const lead = await loadLead({ db }, leadId);
  const cat = DEAL_CATS.includes(b.category) ? b.category : '主約';
  if (!isDate(b.signed_date)) throw new HttpError(400, 'signed_date（簽約日）必填，格式 YYYY-MM-DD');
  for (const k of ['start_date', 'end_date']) if (b[k] && !isDate(b[k])) throw new HttpError(400, `${k} 格式要是 YYYY-MM-DD`);
  const items = normItems(b.items, cat);
  const total = items.reduce((s, it) => s + it.amount, 0);
  const notes = [];
  const inst = normInst(b.installments, total, b.signed_date, me.role === 'admin', notes);
  let acc = await accountForLead(db, leadId);
  if (acc && !b.confirm_not_duplicate) {
    const same = (await db.get(`contracts?account_id=eq.${acc.id}&select=id,name,amount,signed_date`)).filter(c => c.signed_date === b.signed_date && Math.abs((Number(c.amount) || 0) - total) <= 1);
    if (same.length) return { ok: false, possible_duplicate: same, message: '這家同一天已有金額相同的成交單，請跟使用者確認；確定不是重複再帶 confirm_not_duplicate=true。' };
  }
  if (!acc) acc = await db.insert('accounts', { name: lead.name, company: lead.company || null, lead_id: leadId, user_id: lead.user_id || me.id, user_name: lead.user_name || me.name, created_at: new Date().toISOString() });
  const monthly = num(b.monthly_fee);
  const ct = await db.insert('contracts', {
    account_id: acc.id, user_id: me.id, created_at: new Date().toISOString(),
    name: String(b.plan_name || '').trim() || items[0].name, deal_category: cat, amount: total, items, installments: inst,
    monthly_fee: monthly, plan_content: b.plan_content || null, signed_date: b.signed_date, start_date: b.start_date || null, end_date: b.end_date || null,
    remind_days: 30, sales_user_id: lead.user_id || me.id, sales_user_name: lead.user_name || me.name,
    note: [b.note, '（由 ChatGPT 助理建立）'].filter(Boolean).join('\n')
  });
  const L = await lookups(db);
  const won = L.stageByName('簽約進件');
  if (won && lead.stage_id !== won.id) await db.update('leads', `id=eq.${leadId}`, { stage_id: won.id, updated_at: new Date().toISOString() });
  return { ok: true, lead: lead.name, deal: dealView(ct), notes: notes.length ? notes : undefined, crm_link: url.origin + '/#lead=' + leadId };
}
async function loadDeal(db, id) {
  const c = (await db.get(`contracts?id=eq.${id}&select=*`))?.[0];
  if (!c) throw new HttpError(404, '找不到這張成交單（或沒有權限）');
  return c;
}
async function updateDeal({ db, me }, id, b) {
  const c = await loadDeal(db, id);
  const upd = {};
  for (const k of ['signed_date', 'start_date', 'end_date']) if (b[k] !== undefined) { if (b[k] && !isDate(b[k])) throw new HttpError(400, `${k} 格式要是 YYYY-MM-DD`); upd[k] = b[k] || null; }
  if (b.plan_name !== undefined) upd.name = String(b.plan_name).trim() || c.name;
  if (b.category !== undefined) { if (!DEAL_CATS.includes(b.category)) throw new HttpError(400, '類別要是：' + DEAL_CATS.join('、')); upd.deal_category = b.category; }
  if (b.monthly_fee !== undefined) upd.monthly_fee = num(b.monthly_fee);
  if (b.plan_content !== undefined) upd.plan_content = b.plan_content || null;
  if (b.note !== undefined) upd.note = b.note || null;
  const notes = [];
  if (b.items !== undefined || b.installments !== undefined) {
    const items = b.items !== undefined ? normItems(b.items, upd.deal_category || c.deal_category) : ctItems(c);
    const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const old = ctInst(c);
    let inst;
    if (b.installments !== undefined) inst = normInst(b.installments, total, upd.signed_date || c.signed_date, me.role === 'admin', notes);
    else if (old.length === 1 && !old[0].paid_date) inst = [{ ...old[0], amount: total }];
    else throw new HttpError(400, '明細金額改了，請一起提供 installments（付款期數）');
    // 已確認的收款一律保留
    old.forEach((op, i) => { if (op.paid_date && inst[i] && !inst[i].paid_date) for (const k of ['paid_date', 'paid_amount', 'paid_by', 'paid_at']) if (op[k] != null) inst[i][k] = op[k]; });
    Object.assign(upd, { items, installments: inst, amount: total });
  }
  if (!Object.keys(upd).length) throw new HttpError(400, '沒有要更新的欄位');
  const r = await db.update('contracts', `id=eq.${id}`, upd);
  return { ok: true, deal: dealView(r?.[0] || { ...c, ...upd }), notes: notes.length ? notes : undefined };
}
async function recordPayment({ db, me }, id, b) {
  if (me.role !== 'admin') throw new HttpError(403, '只有管理員可以確認收款（獎金依收款月份計算）');
  const c = await loadDeal(db, id);
  const inst = JSON.parse(JSON.stringify(ctInst(c)));
  let i = b.installment_index != null ? parseInt(b.installment_index, 10) : inst.findIndex(p => !p.paid_date);
  if (b.label) i = inst.findIndex(p => p.label === b.label);
  const p = inst[i];
  if (!p) throw new HttpError(400, '找不到這一期，請先用 get_customer_deals 看 installments 的 index');
  if (p.paid_date) return { ok: false, message: `「${p.label}」已在 ${p.paid_date} 收款，沒有變更` };
  const d = b.paid_date || todayTW();
  if (!isDate(d)) throw new HttpError(400, 'paid_date 要是 YYYY-MM-DD');
  Object.assign(p, { paid_date: d, paid_amount: num(b.paid_amount) ?? (Number(p.amount) || 0), paid_by: me.name + '（ChatGPT）', paid_at: new Date().toISOString() });
  await db.update('contracts', `id=eq.${id}`, { installments: inst, items: ctItems(c) });
  return { ok: true, deal: c.name, installment: p.label, paid_date: d, paid_amount: p.paid_amount };
}
async function listCustomers({ db, url }) {
  const accs = await db.get('accounts?select=id,name,lead_id,status,user_name,contracts(*)&limit=500');
  const rows = accs.map(a => ({ name: a.name, status: a.status === 'terminated' ? '終止合作' : '合作中', owner: a.user_name || null, ...finSummary(a.contracts || []), crm_link: a.lead_id ? url.origin + '/#lead=' + a.lead_id : null, lead_id: a.lead_id }));
  rows.sort((x, y) => (x.status === y.status ? y.monthly_fee - x.monthly_fee : x.status === '合作中' ? -1 : 1));
  const act = rows.filter(r => r.status === '合作中');
  return { today: todayTW(), active_customers: act.length, monthly_recurring: act.reduce((s, r) => s + r.monthly_fee, 0), total_contracted: rows.reduce((s, r) => s + r.total, 0), total_paid: rows.reduce((s, r) => s + r.paid, 0), total_unpaid: rows.reduce((s, r) => s + r.unpaid, 0), customers: rows };
}

// ───────────────────────── OpenAPI（給 GPT Actions）─────────────────────────
function openapi(origin) {
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: '名單 id（先用 searchLeads 取得）' };
  const owner = { name: 'owner', in: 'query', required: false, schema: { type: 'string' }, description: '僅主管有效：業務姓名，或 all 代表全隊' };
  const ok = { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } };
  const body = (props, required = []) => ({ required: true, content: { 'application/json': { schema: { type: 'object', properties: props, required } } } });
  return {
    openapi: '3.1.0',
    info: { title: 'SaleFlow CRM', version: '1.0.0', description: '奧德上 SaleFlow CRM：查名單、記活動、更新下次聯絡日與階段、主管報表。時間一律台北時間。' },
    servers: [{ url: origin }],
    paths: {
      '/api/me': { get: { operationId: 'getMe', summary: '取得目前登入者、今天日期（台北）、可用階段與活動類型。每段對話開始先呼叫一次。', responses: ok } },
      '/api/leads': {
        get: { operationId: 'searchLeads', summary: '用公司名/簡稱/統編/聯絡人姓名或電話搜尋名單', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: ok },
        post: {
          operationId: 'createLead', summary: '新增一筆名單（會自動檢查統編與相近名稱是否重複）', 'x-openai-isConsequential': true,
          requestBody: body({
            name: { type: 'string', description: '公司名稱' }, tax_id: { type: 'string', description: '8 碼統編（選填）' },
            stage: { type: 'string', description: '階段名稱，預設第一個階段' }, product_type: { type: 'string' },
            contact_name: { type: 'string' }, contact_title: { type: 'string' }, contact_phone: { type: 'string' }, contact_email: { type: 'string' },
            confirm_not_duplicate: { type: 'boolean', description: '使用者確認不是重複名單後才設 true' }
          }, ['name']), responses: ok
        }
      },
      '/api/leads/{id}': { get: { operationId: 'getLead', summary: '看一筆名單的完整狀況：階段、負責業務、下次聯絡日、聯絡人、最近 15 筆活動', parameters: [id], responses: ok } },
      '/api/leads/{id}/activities': {
        post: {
          operationId: 'addActivity', summary: '新增一筆活動紀錄，並可同時設定下次聯絡日', 'x-openai-isConsequential': true, parameters: [id],
          requestBody: body({
            type: { type: 'string', enum: Object.keys(ACTIVITY_TYPES), description: 'email=Email, call=電話/LINE, visit=實體拜訪, event=展覽活動, note=內部備註' },
            content: { type: 'string', description: '整理過的紀錄內容（重點、對方需求、下一步）' },
            contact_name: { type: 'string', description: '這次互動的聯絡人姓名（選填）' },
            occurred_at: { type: 'string', description: '發生時間，台北時間 YYYY-MM-DD HH:mm；沒講就省略（=現在）' },
            next_contact_date: { type: 'string', description: 'YYYY-MM-DD 設定下次聯絡日；none 清除；省略則沿用 CRM 預設規則' }
          }, ['type', 'content']), responses: ok
        }
      },
      '/api/leads/{id}/next-contact': {
        patch: { operationId: 'setNextContact', summary: '設定或清除下次聯絡日', 'x-openai-isConsequential': true, parameters: [id], requestBody: body({ date: { type: 'string', description: 'YYYY-MM-DD，或 none 清除' } }, ['date']), responses: ok }
      },
      '/api/leads/{id}/stage': {
        patch: { operationId: 'setStage', summary: '變更名單階段（不能改成 結案、簽約進件，那兩個要在 CRM 裡操作）', 'x-openai-isConsequential': true, parameters: [id], requestBody: body({ stage: { type: 'string', description: '階段名稱，要跟 getMe 回傳的一致' } }, ['stage']), responses: ok }
      },
      '/api/followups': {
        get: { operationId: 'getFollowups', summary: '待聯絡清單：下次聯絡日在今天+days 以前（含逾期）。業務只看自己；主管可用 owner 看別人或 all', parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 0 }, description: '往後看幾天，0=只看今天與逾期' }, owner], responses: ok }
      },
      '/api/report/activity': {
        get: { operationId: 'getActivityReport', summary: '活動報表：期間內每位業務做了哪些活動、碰了哪些公司（含內容摘要），用來做週報/月報總結。業務只看得到自己', parameters: [{ name: 'from', in: 'query', schema: { type: 'string' }, description: 'YYYY-MM-DD，預設 7 天前' }, { name: 'to', in: 'query', schema: { type: 'string' }, description: 'YYYY-MM-DD，預設今天' }, owner], responses: ok }
      },
      '/api/report/attention': {
        get: { operationId: 'getAttentionReport', summary: '需要關注的案子：逾期未追、以及超過 stale_days 天沒有任何更新的進行中案子（依階段分組）', parameters: [{ name: 'stale_days', in: 'query', schema: { type: 'integer', default: 30 } }, owner], responses: ok }
      }
    },
    components: { schemas: {} }
  };
}
