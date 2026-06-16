# Cron externo (plano Hobby Vercel)

No plano **Hobby**, a Vercel só permite cron **1x por dia**. Para drenar a fila de distribuição em tempo real (~1 lead/segundo), use um cron **externo** chamando o endpoint da API.

## 1. Configurar secret na Vercel

1. Acesse o projeto na Vercel → **Settings** → **Environment Variables**
2. Adicione:

| Variável | Valor |
|----------|-------|
| `CRON_SECRET` | Uma string longa e aleatória (ex.: gere com `openssl rand -hex 32`) |
| `KOMMO_PRESENCE_SECRET` | Secret para autenticar eventos da extensão KommoOnlineUsers |
| `ABSENCE_GRACE_MS` | `600000` (10 min) — tempo de grace antes do offline automático |

3. Faça **redeploy** após salvar.

## 2. Configurar cron-job.org (recomendado)

1. Crie conta em [cron-job.org](https://cron-job.org) (grátis)
2. Crie **dois** cronjobs:

### Job 1 — Processar filas de distribuição

| Campo | Valor |
|-------|-------|
| Title | UsersZon - Processar filas |
| URL | `https://userszon-status-api.vercel.app/api/cron/process-queues` |
| Schedule | Every **1 minute** |
| Request method | `GET` |

### Job 2 — Processar ausência (grace period)

| Campo | Valor |
|-------|-------|
| Title | UsersZon - Processar ausência |
| URL | `https://userszon-status-api.vercel.app/api/cron/process-absence` |
| Schedule | Every **1 minute** |
| Request method | `GET` |

3. Em **Advanced** → **Headers** de cada job, adicione:

```
Authorization: Bearer SEU_CRON_SECRET_AQUI
```

(Substitua pelo mesmo valor de `CRON_SECRET` na Vercel.)

4. Salve e ative os jobs.

## 3. Testar manualmente

### Filas de distribuição

```bash
curl -s -H "Authorization: Bearer SEU_CRON_SECRET" \
  https://userszon-status-api.vercel.app/api/cron/process-queues
```

Resposta esperada:

```json
{ 
  "message": "Filas processadas.",
  "elapsedMs": 12345,
  "results": [
    { "groupSlug": "rota", "acquired": true, "processed": 10, "pendingRemaining": 5 }
  ]
}
```

### Ausência automática (grace period)

```bash
curl -s -H "Authorization: Bearer SEU_CRON_SECRET" \
  https://userszon-status-api.vercel.app/api/cron/process-absence
```

Resposta esperada:

```json
{
  "message": "Ausências processadas.",
  "elapsedMs": 120,
  "processed": 1,
  "results": [
    { "userId": "12610415", "action": "offline", "groups": ["digital"] }
  ]
}
```

### Evento de presença (extensão KommoOnlineUsers)

```bash
curl -s -X POST \
  -H "Authorization: Bearer SEU_KOMMO_PRESENCE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":"12610415","status":"offline"}' \
  https://userszon-status-api.vercel.app/api/v1/kommo-presence
```

## 4. Cron interno da Vercel (backup)

O `vercel.json` inclui um cron **diário** às 06:00 UTC (`0 6 * * *`) como rede de segurança para jobs presos. O processamento contínuo depende do cron externo.

## 5. Variáveis de fila (opcional)

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `DISTRIBUTION_DELAY_MS` | `1000` | Delay entre leads (evita 429 no Kommo) |
| `DISTRIBUTION_MAX_JOBS_PER_RUN` | `10` | Jobs por invocação (cabe em 60s no Hobby) |
| `DISTRIBUTION_QUEUE_LOCK_TTL_MS` | `90000` | TTL do lock da fila |
| `DISTRIBUTION_STALE_JOB_MS` | `120000` | Jobs `processing` presos voltam para `pending` |
| `ABSENCE_GRACE_MS` | `600000` | Grace period (10 min) antes do offline automático na API |

## Extensão KommoOnlineUsers

Configure o mesmo valor de `KOMMO_PRESENCE_SECRET` na extensão:

- Em `interceptor.js` → `CONFIG.presenceSecret`, ou
- No console do Kommo: `localStorage.setItem('kommo_presence_secret', 'SEU_SECRET')`

## Alternativas ao cron-job.org

- **GitHub Actions** — workflow `schedule: '*/1 * * * *'` com `curl` no endpoint
- **UptimeRobot / EasyCron** — mesmo padrão: GET + header `Authorization`
- **Worker Railway/Render** — script Node com `setInterval` de 30–60s
