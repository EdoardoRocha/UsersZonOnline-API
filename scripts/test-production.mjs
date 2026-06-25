const BASE = process.env.BASE_URL ?? "https://userszon-status-api.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const BURST_SIZE = Number(process.env.BURST_SIZE ?? 28);
const BURST_GROUP = process.env.BURST_GROUP ?? "rota";
const BURST_BASE_ID = Number(process.env.BURST_BASE_ID ?? 99999001);

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

  console.log(`\n=== 4. Fila ${BURST_GROUP} (antes do burst) ===`);
  const queueBefore = await request(`/api/v1/distribution/${BURST_GROUP}/queue`);
  console.log(queueBefore.status, queueBefore.body);

  console.log(`\n=== 5. Webhook burst (${BURST_SIZE} leads) ===`);
  const leadIds = Array.from({ length: BURST_SIZE }, (_, i) => BURST_BASE_ID + i);
  const webhookResults = await Promise.all(
    leadIds.map(async (id) => {
      const r = await request(`/api/v1/distribution/${BURST_GROUP}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: { add: [{ id }] } }),
      });
      return {
        id,
        status: r.status,
        message: r.body?.message ?? r.body,
        enqueued: r.body?.enqueued,
      };
    }),
  );
  const okCount = webhookResults.filter((r) => r.status === 200).length;
  console.log(`Webhooks OK: ${okCount}/${BURST_SIZE}`);
  if (BURST_SIZE <= 10) {
    console.table(webhookResults);
  }

  console.log(`\n=== 6. Fila ${BURST_GROUP} (após burst, antes do cron) ===`);
  await new Promise((r) => setTimeout(r, 2000));
  const queueMid = await request(`/api/v1/distribution/${BURST_GROUP}/queue`);
  console.log(queueMid.status, queueMid.body);

  if (CRON_SECRET) {
    console.log("\n=== 7. Cron após webhooks (drenagem) ===");
    await new Promise((r) => setTimeout(r, 3000));
    const cronAfter = await request("/api/cron/process-queues", {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    console.log(cronAfter.status, JSON.stringify(cronAfter.body, null, 2));

    console.log(`\n=== 8. Fila ${BURST_GROUP} (depois do cron) ===`);
    const queueAfter = await request(`/api/v1/distribution/${BURST_GROUP}/queue`);
    console.log(queueAfter.status, queueAfter.body);

    const rotaResult = cronAfter.body?.results?.find(
      (r) => r.groupSlug === BURST_GROUP,
    );
    if (rotaResult) {
      console.log(
        `\nResumo ${BURST_GROUP}: processados=${rotaResult.processed}, pendentes=${rotaResult.pendingRemaining}, motivo=${rotaResult.stoppedReason ?? "n/a"}`,
      );
    }
  }

  console.log("\n=== 9. Teste multi-lead em um único payload ===");
  const multiIds = [BURST_BASE_ID + 1000, BURST_BASE_ID + 1001, BURST_BASE_ID + 1002];
  const multi = await request(`/api/v1/distribution/${BURST_GROUP}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      leads: { add: multiIds.map((id) => ({ id })) },
    }),
  });
  console.log(multi.status, multi.body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
