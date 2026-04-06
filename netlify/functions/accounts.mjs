// Lucky Maze Accounts API
const SITE_ID = "8b5e215c-2e7a-474d-9b8a-d49cfc6d0215";
const STORE   = "lm-accounts";
const TOKEN   = process.env.NETLIFY_TOKEN;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function blobGet(key) {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function blobSet(key, data) {
  await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}

function hashPin(pin) {
  // Simple hash - not cryptographic but sufficient for game PINs
  let hash = 0;
  const str = pin + "lm_salt_2026";
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitize(str, max = 20) {
  return String(str || "").replace(/[^a-zA-Z0-9_\- ]/g, "").trim().slice(0, max);
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });

  const url = new URL(req.url);
  const path = url.pathname;
  let body = {};
  if (req.method === "POST" || req.method === "PUT") {
    try { body = await req.json(); } catch {}
  }

  // POST /api/accounts/register
  if (path === "/api/accounts/register" && req.method === "POST") {
    const username = sanitize(body.username);
    const pin = String(body.pin || "").replace(/\D/g, "").slice(0, 6);
    if (!username || username.length < 2) return new Response(JSON.stringify({ error: "Username must be 2-20 characters" }), { status: 400, headers });
    if (!pin || pin.length < 4) return new Response(JSON.stringify({ error: "PIN must be at least 4 digits" }), { status: 400, headers });

    const existing = await blobGet(username.toLowerCase());
    if (existing) return new Response(JSON.stringify({ error: "Username already taken" }), { status: 409, headers });

    const account = {
      username,
      pinHash: hashPin(pin),
      gc: 25000,
      sc: 0.30,
      totalSpins: 0,
      totalWins: 0,
      purchases: [],
      created: Date.now(),
      lastLogin: Date.now()
    };
    await blobSet(username.toLowerCase(), account);
    const { pinHash, ...safe } = account;
    return new Response(JSON.stringify({ ok: true, account: safe }), { status: 200, headers });
  }

  // POST /api/accounts/login
  if (path === "/api/accounts/login" && req.method === "POST") {
    const username = sanitize(body.username);
    const pin = String(body.pin || "").replace(/\D/g, "").slice(0, 6);
    if (!username || !pin) return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers });

    const account = await blobGet(username.toLowerCase());
    if (!account) return new Response(JSON.stringify({ error: "Account not found" }), { status: 404, headers });
    if (account.pinHash !== hashPin(pin)) return new Response(JSON.stringify({ error: "Wrong PIN" }), { status: 401, headers });

    account.lastLogin = Date.now();
    await blobSet(username.toLowerCase(), account);
    const { pinHash, ...safe } = account;
    return new Response(JSON.stringify({ ok: true, account: safe }), { status: 200, headers });
  }

  // PUT /api/accounts/sync - save current balance
  if (path === "/api/accounts/sync" && req.method === "PUT") {
    const username = sanitize(body.username);
    const pin = String(body.pin || "").replace(/\D/g, "").slice(0, 6);
    if (!username || !pin) return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers });

    const account = await blobGet(username.toLowerCase());
    if (!account) return new Response(JSON.stringify({ error: "Account not found" }), { status: 404, headers });
    if (account.pinHash !== hashPin(pin)) return new Response(JSON.stringify({ error: "Wrong PIN" }), { status: 401, headers });

    // Update balance - only allow increases in sc (prevent cheating by not allowing sc to decrease via sync)
    account.gc = Math.max(0, Math.min(body.gc || account.gc, 99999999));
    account.sc = Math.max(account.sc, Math.min(body.sc || account.sc, 99999));
    account.totalSpins = Math.max(account.totalSpins, body.totalSpins || 0);
    account.totalWins = Math.max(account.totalWins, body.totalWins || 0);
    account.lastSync = Date.now();
    await blobSet(username.toLowerCase(), account);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  // GET /api/accounts/balance?username=x&pin=y
  if (path === "/api/accounts/balance" && req.method === "GET") {
    const username = sanitize(url.searchParams.get("username"));
    const pin = String(url.searchParams.get("pin") || "").replace(/\D/g, "");
    const account = await blobGet(username.toLowerCase());
    if (!account) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
    if (account.pinHash !== hashPin(pin)) return new Response(JSON.stringify({ error: "Wrong PIN" }), { status: 401, headers });
    const { pinHash, ...safe } = account;
    return new Response(JSON.stringify(safe), { status: 200, headers });
  }

  // PUT /api/accounts/credit - add GC/SC to account (called by payment webhook)
  if (path === "/api/accounts/credit" && req.method === "PUT") {
    const adminKey = process.env.ADMIN_KEY || "lm_admin_2026";
    if (body.adminKey !== adminKey) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });

    const username = sanitize(body.username);
    const account = await blobGet(username.toLowerCase());
    if (!account) return new Response(JSON.stringify({ error: "Account not found" }), { status: 404, headers });

    account.gc += Math.floor(body.gc || 0);
    account.sc += parseFloat((body.sc || 0).toFixed(2));
    account.purchases = account.purchases || [];
    account.purchases.push({
      amount: body.amount,
      package: body.package,
      gc: body.gc,
      sc: body.sc,
      method: body.method,
      txId: body.txId,
      at: Date.now()
    });
    await blobSet(username.toLowerCase(), account);
    return new Response(JSON.stringify({ ok: true, gc: account.gc, sc: account.sc }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
}

export const config = { path: "/api/accounts/:action" };
