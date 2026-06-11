const BASE = "https://userszon-status-api.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body };
}

async function main() {
  console.log("=== 1. Health ===");
  const health = await request("/api/v1/health");
  console.log(health.status, health.body);

  console.log("\n=== 2. Cron sem auth (esperado 401) ===");
  const cronNoAuth = await request("/api/cron/process-queues");
  console.log(cronNoAuth.status, cronNoAuth.body);

  console.log("\n=== 3. Cron com CRON_SECRET ===");
  if (!CRON_SECRET) {
    console.log("SKIP: defina CRON_SECRET no ambiente para testar cron autenticado");
    console.log("  Ex: CRON_SECRET=seu_secret node scripts/test-production.mjs");
  } else {
    const cronAuth = await request("/api/cron/process-queues", {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    console.log(cronAuth.status, JSON.stringify(cronAuth.body, null, 2));
  }

  console.log("\n=== 4. Webhook burst (5 leads) ===");
  const leadIds = [99999101, 99999102, 99999103, 99999104, 99999105];
  const webhookResults = await Promise.all(
    leadIds.map(async (id) => {
      const r = await request("/api/v1/distribution/rota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: { add: [{ id }] } }),
      });
      return { id, status: r.status, message: r.body?.message ?? r.body };
    }),
  );
  console.table(webhookResults);

  if (CRON_SECRET) {
    console.log("\n=== 5. Cron após webhooks ===");
    await new Promise((r) => setTimeout(r, 3000));
    const cronAfter = await request("/api/cron/process-queues", {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    console.log(cronAfter.status, JSON.stringify(cronAfter.body, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
