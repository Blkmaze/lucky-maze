// Lucky Maze PayPal IPN/Webhook Handler
// PayPal sends payment notifications here → we credit the player's account

const SITE_ID   = "8b5e215c-2e7a-474d-9b8a-d49cfc6d0215";
const STORE     = "lm-accounts";
const TOKEN     = process.env.NETLIFY_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || "lm_admin_2026";
const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || "willie.mayes@gmail.com";

// Coin packages - must match frontend
const PACKAGES = {
  "starter":  { price: 4.99,  gc: 50000,   sc: 2  },
  "popular":  { price: 9.99,  gc: 150000,  sc: 5  },
  "value":    { price: 24.99, gc: 500000,  sc: 15 },
  "premium":  { price: 49.99, gc: 1200000, sc: 35 },
};

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function creditAccount(username, pkg, txId, method) {
  const account = await blobGet(username.toLowerCase());
  if (!account) return { error: "Account not found" };

  // Prevent double-crediting
  const purchases = account.purchases || [];
  if (purchases.some(p => p.txId === txId)) return { error: "Already credited" };

  account.gc += pkg.gc;
  account.sc = parseFloat((account.sc + pkg.sc).toFixed(2));
  purchases.push({
    package: pkg.name,
    amount: pkg.price,
    gc: pkg.gc,
    sc: pkg.sc,
    method,
    txId,
    at: Date.now()
  });
  account.purchases = purchases;
  await blobSet(username.toLowerCase(), account);
  return { ok: true, gc: account.gc, sc: account.sc };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  const url = new URL(req.url);
  const path = url.pathname;

  // ── PayPal IPN handler ─────────────────────────────────────
  if (path === "/api/payment/paypal-ipn") {
    const rawBody = await req.text();

    // Verify with PayPal
    const verification = await fetch("https://ipnpb.paypal.com/cgi-bin/webscr", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "cmd=_notify-validate&" + rawBody
    });
    const verifyText = await verification.text();
    if (verifyText !== "VERIFIED") {
      console.log("PayPal IPN not verified:", verifyText);
      return new Response("NOT VERIFIED", { status: 200 });
    }

    const params = new URLSearchParams(rawBody);
    const paymentStatus = params.get("payment_status");
    const receiverEmail = params.get("receiver_email");
    const txId = params.get("txn_id");
    const amount = parseFloat(params.get("mc_gross") || "0");
    const custom = params.get("custom") || ""; // format: "username:packageId"

    if (paymentStatus !== "Completed") return new Response("OK", { status: 200 });
    if (receiverEmail?.toLowerCase() !== PAYPAL_EMAIL.toLowerCase()) return new Response("OK", { status: 200 });

    const [username, packageId] = custom.split(":");
    const pkg = PACKAGES[packageId];
    if (!pkg || !username) return new Response("OK", { status: 200 });
    if (Math.abs(amount - pkg.price) > 0.50) return new Response("OK", { status: 200 }); // amount mismatch

    await creditAccount(username, { ...pkg, name: packageId }, txId, "paypal");
    return new Response("OK", { status: 200 });
  }

  // ── Manual credit endpoint (admin use) ─────────────────────
  if (path === "/api/payment/manual-credit") {
    let body = {};
    try { body = JSON.parse(await req.text()); } catch {}
    if (body.adminKey !== ADMIN_KEY) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });

    const pkg = PACKAGES[body.packageId];
    if (!pkg) return new Response(JSON.stringify({ error: "Invalid package" }), { status: 400, headers });

    const result = await creditAccount(body.username, { ...pkg, name: body.packageId }, body.txId || `manual_${Date.now()}`, body.method || "manual");
    return new Response(JSON.stringify(result), { status: 200, headers });
  }

  // ── Create PayPal payment URL ───────────────────────────────
  if (path === "/api/payment/create") {
    let body = {};
    try { body = JSON.parse(await req.text()); } catch {}
    const { username, packageId } = body;
    const pkg = PACKAGES[packageId];
    if (!pkg || !username) return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers });

    // Build PayPal payment URL
    const params = new URLSearchParams({
      cmd: "_xclick",
      business: PAYPAL_EMAIL,
      item_name: `Lucky Maze — ${packageId} pack (${pkg.gc.toLocaleString()} GC + ${pkg.sc} SC)`,
      amount: pkg.price.toFixed(2),
      currency_code: "USD",
      custom: `${username}:${packageId}`,
      notify_url: "https://lucky-maze.netlify.app/api/payment/paypal-ipn",
      return: "https://lucky-maze.netlify.app/?payment=success",
      cancel_return: "https://lucky-maze.netlify.app/?payment=cancelled",
      no_shipping: "1",
      no_note: "1"
    });

    const paypalUrl = `https://www.paypal.com/cgi-bin/webscr?${params.toString()}`;
    return new Response(JSON.stringify({ ok: true, url: paypalUrl, package: pkg }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
}

export const config = { path: "/api/payment/:action" };
