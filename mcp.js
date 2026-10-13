// SaleFlow CRM — MCP 入口（給 ChatGPT 外掛程式 / Claude / Gemini 用）
// 包住 worker.js：/mcp、OAuth（discovery、註冊、登入、換 token）在這裡處理，
// 其他路徑原樣交給 worker.js。工具一律轉呼叫既有的 /api，權限與邏輯完全共用。
import app from './worker.js';

const SERVER = { name: 'saleflow-crm', version: '1.1.0' };
const INSTRUCTIONS = `你在操作奧德上（OrderUp B2B）的 SaleFlow CRM。一律繁體中文、簡潔回覆。
- 對話開始先呼叫 get_me 取得使用者、角色與今天日期（台北時間），相對日期都用它換算成 YYYY-MM-DD。
- 記錄活動：search_leads 找公司 → 整理內容（重點、需求、下一步，不加料）→ 先向使用者複述公司、類型、聯絡人、內容、下次聯絡日並取得確認 → add_activity。
- 改階段 set_stage、改下次聯絡日 set_next_contact，都先確認。「結案」「簽約進件」只能在 CRM 裡操作，請提供 crm_link。
- 主管總結：get_activity_report（owner=all）、get_attention_report；先講結論與風險，再列細節。
- 報價單／合約截圖：逐張讀出公司、統編、方案、各項目未稅折後金額、月費、合約期間、付款方式。search_leads（可用統編）找公司，找不到先 create_lead；已成交的用 record_deal 建成交單（items 用未稅折後金額，月費填 monthly_fee，合約起訖填 start_date／end_date），寫入前先列表給使用者確認。只是報價、還沒成交的，用 add_activity（note）記報價重點。
- 看客戶合約、已收／未收、月費：get_customer_deals；全部客戶總覽：list_customers。收款確認用 record_payment（限管理員）。
- 只根據工具回傳資料回答，不捏造；沒有刪除功能。`;

const T = (name, description, properties = {}, required = [], readOnly = true) => ({
  name, description,
  inputSchema: { type: 'object', properties, required },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false }
});
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const owner = S('僅主管有效：業務姓名，或 all 代表全隊');
const TOOLS = [
  T('get_me', '取得目前登入者、角色、今天日期（台北）、可用階段與活動類型。每段對話先呼叫一次。'),
  T('search_leads', '用公司名/簡稱/統編/聯絡人姓名或電話搜尋名單', { q: S('關鍵字') }, ['q']),
  T('get_lead', '看一筆名單的完整狀況：階段、負責業務、下次聯絡日、聯絡人、最近 15 筆活動', { lead_id: S('名單 id（先用 search_leads 取得）') }, ['lead_id']),
  T('create_lead', '新增名單（會自動檢查統編與相近名稱重複）', {
    name: S('公司名稱'), tax_id: S('8 碼統編（選填）'), stage: S('階段名稱，預設第一個階段'), product_type: S('產品類型（選填）'),
    contact_name: S('聯絡人'), contact_title: S('職稱'), contact_phone: S('電話'), contact_email: S('Email'),
    confirm_not_duplicate: { type: 'boolean', description: '使用者確認不是重複名單後才設 true' }
  }, ['name'], false),
  T('add_activity', '新增一筆活動紀錄，並可同時設定下次聯絡日', {
    lead_id: S('名單 id'),
    type: S('email=Email, call=電話/LINE, visit=實體拜訪, event=展覽活動, note=內部備註', { enum: ['email', 'call', 'visit', 'event', 'note'] }),
    content: S('整理過的紀錄內容'), contact_name: S('互動的聯絡人姓名（選填）'),
    occurred_at: S('發生時間，台北時間 YYYY-MM-DD HH:mm；省略=現在'),
    next_contact_date: S('YYYY-MM-DD 設定下次聯絡日；none 清除；省略則照 CRM 預設規則')
  }, ['lead_id', 'type', 'content'], false),
  T('set_next_contact', '設定或清除下次聯絡日', { lead_id: S('名單 id'), date: S('YYYY-MM-DD，或 none 清除') }, ['lead_id', 'date'], false),
  T('set_stage', '變更名單階段（不能改成 結案、簽約進件）', { lead_id: S('名單 id'), stage: S('階段名稱，需與 get_me 一致') }, ['lead_id', 'stage'], false),
  T('list_customers', '成交客戶總覽：每家的月費、合約期間、合約總額、已收、未收、下次收款；以及全公司月費合計'),
  T('get_customer_deals', '看一家公司的成交單與收款：月費、合約期間、明細、付款期數（含 index）、已收／未收', { lead_id: S('名單 id') }, ['lead_id']),
  T('record_deal', '建立成交單（會自動把公司轉為成交客戶、階段移到簽約進件）。金額一律未稅、折後實收', {
    lead_id: S('名單 id'), plan_name: S('方案名稱，例如 Light 輕量版'),
    category: S('成交類型', { enum: ['主約', '加購專案', '客製案件', '續約', '其他'] }),
    items: { type: 'array', description: '成交明細（未稅折後）。贈送填 0', items: { type: 'object', properties: { name: S('項目名稱'), amount: { type: 'number', description: '未稅折後金額' }, type: S('subscription=訂閱月費/年費, setup=導入建置, addon=加購, custom=客製, gift=贈送', { enum: ['subscription', 'setup', 'addon', 'custom', 'gift'] }) }, required: ['name', 'amount'] } },
    installments: { type: 'array', description: '付款期數，合計要等於明細合計；省略＝一次付清。已收款可帶 paid_date（限管理員）', items: { type: 'object', properties: { label: S('期別名稱'), amount: { type: 'number' }, due_date: S('YYYY-MM-DD'), paid_date: S('實收日 YYYY-MM-DD（已收才填）'), paid_amount: { type: 'number' } }, required: ['amount'] } },
    monthly_fee: { type: 'number', description: '月費（未稅）' },
    signed_date: S('簽約日 YYYY-MM-DD（報價單日期或客戶確認日）'), start_date: S('合約／系統啟用日 YYYY-MM-DD'), end_date: S('合約到期／續約日 YYYY-MM-DD'),
    plan_content: S('方案內容：訂單額度、贈送、優惠條件等'), note: S('備註，例如報價單號'),
    confirm_not_duplicate: { type: 'boolean', description: '使用者確認不是重複才設 true' }
  }, ['lead_id', 'items', 'signed_date'], false),
  T('update_deal', '修改成交單：月費、合約期間、方案內容、備註；改金額時 items 與 installments 一起給', {
    deal_id: S('成交單 id（get_customer_deals 取得）'), plan_name: S('方案名稱'), category: S('成交類型'), monthly_fee: { type: 'number' },
    signed_date: S('YYYY-MM-DD'), start_date: S('YYYY-MM-DD'), end_date: S('YYYY-MM-DD'), plan_content: S('方案內容'), note: S('備註'),
    items: { type: 'array', items: { type: 'object', properties: { name: S('項目'), amount: { type: 'number' }, type: S('subscription/setup/addon/custom/gift') } } },
    installments: { type: 'array', items: { type: 'object', properties: { label: S('期別'), amount: { type: 'number' }, due_date: S('YYYY-MM-DD') } } }
  }, ['deal_id'], false),
  T('record_payment', '確認某一期已收款（限管理員；獎金依收款月份計算）', {
    deal_id: S('成交單 id'), installment_index: { type: 'integer', description: '第幾期（get_customer_deals 的 index，從 0 開始）；省略＝最早未收的那期' },
    paid_date: S('實收日 YYYY-MM-DD，預設今天'), paid_amount: { type: 'number', description: '實收未稅金額，預設排定金額' }
  }, ['deal_id'], false),
  T('get_followups', '待聯絡清單：下次聯絡日在今天+days 以前（含逾期）', { days: { type: 'integer', description: '往後看幾天，0=今天與逾期' }, owner }),
  T('get_activity_report', '活動報表：期間內每位業務的活動與碰過的公司，用來做週報/月報', { from: S('YYYY-MM-DD，預設 7 天前'), to: S('YYYY-MM-DD，預設今天'), owner }),
  T('get_attention_report', '需要關注的案子：逾期未追、長期沒更新的進行中案子', { stale_days: { type: 'integer', description: '幾天沒動算停滯，預設 30' }, owner })
];
const qs = (a, keys) => { const p = new URLSearchParams(); for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== '') p.set(k, String(a[k])); const s = p.toString(); return s ? '?' + s : ''; };
const pick = (a, keys) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, a[k]]));
const id = a => { if (!/^[0-9a-f-]{36}$/.test(a.lead_id || '')) throw new Error('lead_id 格式不正確，請先用 search_leads 取得'); return a.lead_id; };
const did = a => { if (!/^[0-9a-f-]{36}$/.test(a.deal_id || '')) throw new Error('deal_id 格式不正確，請先用 get_customer_deals 取得'); return a.deal_id; };
const ROUTES = {
  get_me: () => ['GET', '/api/me'],
  search_leads: a => ['GET', '/api/leads' + qs(a, ['q'])],
  get_lead: a => ['GET', '/api/leads/' + id(a)],
  create_lead: a => ['POST', '/api/leads', pick(a, ['name', 'tax_id', 'stage', 'product_type', 'contact_name', 'contact_title', 'contact_phone', 'contact_email', 'confirm_not_duplicate'])],
  add_activity: a => ['POST', `/api/leads/${id(a)}/activities`, pick(a, ['type', 'content', 'contact_name', 'occurred_at', 'next_contact_date'])],
  set_next_contact: a => ['PATCH', `/api/leads/${id(a)}/next-contact`, pick(a, ['date'])],
  set_stage: a => ['PATCH', `/api/leads/${id(a)}/stage`, pick(a, ['stage'])],
  list_customers: () => ['GET', '/api/customers'],
  get_customer_deals: a => ['GET', `/api/leads/${id(a)}/deals`],
  record_deal: a => ['POST', `/api/leads/${id(a)}/deals`, pick(a, ['plan_name', 'category', 'items', 'installments', 'monthly_fee', 'signed_date', 'start_date', 'end_date', 'plan_content', 'note', 'confirm_not_duplicate'])],
  update_deal: a => ['PATCH', `/api/deals/${did(a)}`, pick(a, ['plan_name', 'category', 'items', 'installments', 'monthly_fee', 'signed_date', 'start_date', 'end_date', 'plan_content', 'note'])],
  record_payment: a => ['POST', `/api/deals/${did(a)}/payments`, pick(a, ['installment_index', 'paid_date', 'paid_amount'])],
  get_followups: a => ['GET', '/api/followups' + qs(a, ['days', 'owner'])],
  get_activity_report: a => ['GET', '/api/report/activity' + qs(a, ['from', 'to', 'owner'])],
  get_attention_report: a => ['GET', '/api/report/attention' + qs(a, ['stale_days', 'owner'])]
};

const J = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id', ...h } });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async s => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (request.method === 'OPTIONS') return J({});
      if (p.startsWith('/.well-known/oauth-protected-resource')) return J({ resource: url.origin + '/mcp', authorization_servers: [url.origin], scopes_supported: ['crm'], bearer_methods_supported: ['header'] });
      if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration')) return J(asMeta(url.origin));
      if (p === '/oauth/register') return await register(request);
      if (p === '/oauth/authorize') return await authorize(request, env, url);
      if (p === '/oauth/token') return await token(request, env);
      if (p === '/mcp') return await mcp(request, env, ctx, url);
      return app.fetch(request, env, ctx);
    } catch (e) {
      console.error(e);
      return J({ error: 'server_error', error_description: String(e.message || e) }, 500);
    }
  }
};

// ───────── OAuth ─────────
function asMeta(o) {
  return {
    issuer: o, authorization_endpoint: o + '/oauth/authorize', token_endpoint: o + '/oauth/token', registration_endpoint: o + '/oauth/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['crm']
  };
}
async function register(request) {
  const b = await request.json().catch(() => ({}));
  return J({ client_id: 'saleflow-' + crypto.randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: b.redirect_uris || [], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: b.client_name || 'MCP client' }, 201);
}
// 只允許導回這些 AI 平台（HTTPS）
function okRedirect(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com', 'gemini.google.com'].includes(x.hostname); } catch { return false; }
}
async function body(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await request.json().catch(() => ({}));
  const fd = await request.formData().catch(() => null);
  return fd ? Object.fromEntries(fd) : {};
}
async function sign(env, s) {
  if (!env.OAUTH_SECRET) return '';
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.OAUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(s)));
}
async function sbAuth(env, grant, b) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: { apikey: env.SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}
async function authorize(request, env, url) {
  const q = request.method === 'POST' ? await body(request) : Object.fromEntries(url.searchParams);
  if (!okRedirect(q.redirect_uri)) return page(q, '這個登入連結不正確，請從 ChatGPT 重新連結 SaleFlow。', true, 400);
  if (request.method !== 'POST') return page(q);
  const { ok, data } = await sbAuth(env, 'password', { email: String(q.email || '').trim(), password: q.password || '' });
  if (!ok) return page(q, 'Email 或密碼錯誤（跟登入 SaleFlow CRM 的帳密一樣）', false, 401);
  // code = refresh_token ~ PKCE challenge ~ 簽章（沒有額外儲存）
  const payload = data.refresh_token + '~' + (q.code_challenge || '');
  const code = payload + '~' + await sign(env, payload);
  const to = new URL(q.redirect_uri);
  to.searchParams.set('code', code);
  if (q.state) to.searchParams.set('state', q.state);
  return Response.redirect(to.toString(), 302);
}
async function token(request, env) {
  const b = await body(request);
  let rt;
  if (b.grant_type === 'authorization_code') {
    const parts = String(b.code || '').split('~');
    if (parts.length === 1) rt = parts[0]; // 舊版 GPT 的 code（純 refresh token）
    else {
      const [r, cc, sig] = parts;
      if (sig !== await sign(env, r + '~' + cc)) return J({ error: 'invalid_grant' }, 400);
      if (cc && cc !== await sha256(b.code_verifier || '')) return J({ error: 'invalid_grant', error_description: 'PKCE 驗證失敗' }, 400);
      rt = r;
    }
  } else if (b.grant_type === 'refresh_token') rt = b.refresh_token;
  else return J({ error: 'unsupported_grant_type' }, 400);
  const { ok, data } = await sbAuth(env, 'refresh_token', { refresh_token: rt });
  if (!ok) return J({ error: 'invalid_grant' }, 400);
  return J({ access_token: data.access_token, token_type: 'Bearer', expires_in: data.expires_in || 3600, refresh_token: data.refresh_token, scope: 'crm' });
}
function page(q, err = '', fatal = false, status = 200) {
  const keep = ['response_type', 'client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'resource'];
  const hidden = keep.map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
  const h = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登入 SaleFlow</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#f4f5f7;color:#1f2937;padding:16px}
.c{width:100%;max-width:380px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 4px 24px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 6px}p{color:#6b7280;font-size:14px;margin:0 0 20px;line-height:1.6}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}input[type=email],input[type=password]{width:100%;padding:12px;border:1px solid #d1d5db;border-radius:10px;font-size:16px}
button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:16px;font-weight:600}.e{background:#fef2f2;color:#b91c1c;padding:10px 12px;border-radius:10px;font-size:14px;margin-bottom:8px}
</style></head><body><div class="c"><h1>登入 SaleFlow CRM</h1><p>用你的 SaleFlow CRM 帳號登入，授權 AI 助理幫你查名單、記活動。</p>
${err ? `<div class="e">${esc(err)}</div>` : ''}${fatal ? '' : `<form method="post" action="/oauth/authorize">${hidden}
<label>Email</label><input type="email" name="email" value="${esc(q.email)}" autocomplete="username" required>
<label>密碼</label><input type="password" name="password" autocomplete="current-password" required>
<button type="submit">登入並授權</button></form>`}</div></body></html>`;
  return new Response(h, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ───────── MCP（Streamable HTTP，JSON 回應）─────────
async function mcp(request, env, ctx, url) {
  if (request.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  const auth = request.headers.get('authorization') || '';
  const unauthorized = () => J({ jsonrpc: '2.0', error: { code: -32001, message: '請先登入 SaleFlow' }, id: null }, 401,
    { 'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource", scope="crm"` });
  if (!auth.startsWith('Bearer ')) return unauthorized();
  const msg = await request.json().catch(() => null);
  if (!msg) return J({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);
  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) { const r = await handle(m, request, env, ctx, url, auth); if (r === 401) return unauthorized(); if (r) out.push(r); }
    return out.length ? J(out) : new Response(null, { status: 202 });
  }
  const r = await handle(msg, request, env, ctx, url, auth);
  if (r === 401) return unauthorized();
  return r ? J(r) : new Response(null, { status: 202 });
}
async function handle(m, request, env, ctx, url, auth) {
  const { id, method, params = {} } = m || {};
  if (id === undefined || id === null) return null; // notification
  const ok = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const route = ROUTES[params.name];
      if (!route) return { jsonrpc: '2.0', id, error: { code: -32602, message: '沒有這個工具：' + params.name } };
      let res, data;
      try {
        const [verb, path, b] = route(params.arguments || {});
        const req = new Request(url.origin + path, { method: verb, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        res = await app.fetch(req, env, ctx);
        data = await res.json().catch(() => ({}));
      } catch (e) {
        return ok({ content: [{ type: 'text', text: '錯誤：' + (e.message || e) }], isError: true });
      }
      if (res.status === 401) return 401;
      const isError = !res.ok;
      return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError });
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  }
}
