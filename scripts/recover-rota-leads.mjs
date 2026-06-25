/**
 * Recupera leads da ROTA que ficaram sem distribuição (ex.: failed por "sem online"
 * ou nunca enfileirados).
 *
 * Uso:
 *   LEAD_IDS=123,456,789 CRON_SECRET=xxx node scripts/recover-rota-leads.mjs
 *
 * Opcional:
 *   BASE_URL=https://userszon-status-api.vercel.app
 *   GROUP=rota
 */

const BASE = process.env.BASE_URL ?? "https://userszon-status-api.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const GROUP = process.env.GROUP ?? "rota";
const LEAD_IDS = (process.env.LEAD_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  return { status: res.status, body };
}

async function main() {
  if (!CRON_SECRET) {
    console.error("Defina CRON_SECRET no ambiente.");
    process.exit(1);
  }

  if (!LEAD_IDS.length) {
    console.error(
      "Defina LEAD_IDS com os IDs dos leads separados por vírgula.",
    );
    console.error("Ex: LEAD_IDS=93001,93002,93003 CRON_SECRET=xxx node scripts/recover-rota-leads.mjs");
    process.exit(1);
  }

  const authHeaders = { Authorization: `Bearer ${CRON_SECRET}` };

  console.log(`=== 1. Status da fila ${GROUP} (antes) ===`);
  const queueBefore = await request(`/api/v1/distribution/${GROUP}/queue`);
  console.log(queueBefore.status, queueBefore.body);

  console.log(`\n=== 2. Reconciliar jobs failed reprocessáveis ===`);
  const reconcile = await request(
    `/api/cron/reconcile-queues?group=${GROUP}`,
    { headers: authHeaders },
  );
  console.log(reconcile.status, reconcile.body);

  console.log(`\n=== 3. Re-enfileirar ${LEAD_IDS.length} lead(s) ===`);
  const enqueueResults = [];
  for (const leadId of LEAD_IDS) {
    const r = await request(`/api/v1/distribution/${GROUP}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leads: { add: [{ id: leadId }] } }),
    });
    enqueueResults.push({
      leadId,
      status: r.status,
      message: r.body?.message ?? r.body,
      enqueued: r.body?.enqueued,
      duplicates: r.body?.duplicates,
    });
  }
  console.table(enqueueResults);

  console.log("\n=== 4. Aguardar drenagem em background (15s) ===");
  await new Promise((r) => setTimeout(r, 15000));

  console.log("\n=== 5. Forçar processamento via cron ===");
  const cron = await request("/api/cron/process-queues", {
    headers: authHeaders,
  });
  console.log(cron.status, JSON.stringify(cron.body, null, 2));

  console.log(`\n=== 6. Status da fila ${GROUP} (depois) ===`);
  const queueAfter = await request(`/api/v1/distribution/${GROUP}/queue`);
  console.log(queueAfter.status, queueAfter.body);

  const pending = queueAfter.body?.pending ?? "?";
  console.log(`\nPendente na fila: ${pending}`);
  if (pending === 0) {
    console.log("Recuperação concluída — fila zerada.");
  } else {
    console.log(
      "Ainda há pendências. Verifique se há usuários online na ROTA e rode o cron novamente.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
