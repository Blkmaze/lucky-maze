// Lucky Maze Leaderboard API
const SITE_ID = "8b5e215c-2e7a-474d-9b8a-d49cfc6d0215";
const STORE   = "lm-leaderboard";
const KEY     = "scores";
const TOKEN   = process.env.NETLIFY_TOKEN;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function blobGet() {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${KEY}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!r.ok) return [];
  try { return await r.json(); } catch { return []; }
}

async function blobSet(data) {
  await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${KEY}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });

  if (req.method === "GET") {
    try {
      const entries = await blobGet();
      const sorted = entries.sort((a, b) => b.gc - a.gc);
      return new Response(JSON.stringify({ entries: sorted }), { status: 200, headers });
    } catch(e) {
      return new Response(JSON.stringify({ entries: [] }), { status: 200, headers });
    }
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers }); }

    const { name, gc, sc, spins, wins } = body;
    if (!name || typeof gc !== "number") return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers });

    // Sanitize
    const cleanName = String(name).replace(/[<>&"]/g, "").slice(0, 20);
    const cleanGC   = Math.min(Math.max(0, Math.floor(gc)), 99999999);

    try {
      let entries = await blobGet();
      // Remove existing entry for this name
      entries = entries.filter(e => e.name !== cleanName);
      // Add new entry
      entries.push({ name: cleanName, gc: cleanGC, sc: sc || 0, spins: spins || 0, wins: wins || 0, updated: Date.now() });
      // Keep top 100
      entries.sort((a, b) => b.gc - a.gc);
      entries = entries.slice(0, 100);
      await blobSet(entries);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
}

export const config = { path: "/api/leaderboard" };
