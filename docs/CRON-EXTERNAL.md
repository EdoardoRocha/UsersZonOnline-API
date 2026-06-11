# Cron externo (plano Hobby Vercel)

No plano **Hobby**, a Vercel só permite cron **1x por dia**. Para drenar a fila de distribuição em tempo real (~1 lead/segundo), use um cron **externo** chamando o endpoint da API.

## 1. Configurar secret na Vercel

1. Acesse o projeto na Vercel → **Settings** → **Environment Variables**
2. Adicione:

| Variável | Valor |
|----------|-------|
| `CRON_SECRET` | Uma string longa e aleatória (ex.: gere com `openssl rand -hex 32`) |

3. Faça **redeploy** após salvar.

## 2. Configurar cron-job.org (recomendado)

1. Crie conta em [cron-job.org](https://cron-job.org) (grátis)
2. **Create cronjob** com:

| Campo | Valor |
|-------|-------|
| Title | UsersZon - Processar filas |
| URL | `https://userszon-status-api.vercel.app/api/cron/process-queues` |
| Schedule | Every **1 minute** |
| Request method | `GET` |

3. Em **Advanced** → **Headers**, adicione:

```
Authorization: Bearer SEU_CRON_SECRET_AQUI
```

(Substitua pelo mesmo valor de `CRON_SECRET` na Vercel.)

4. Salve e ative o job.

## 3. Testar manualmente

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

## 4. Cron interno da Vercel (backup)

O `vercel.json` inclui um cron **diário** às 06:00 UTC (`0 6 * * *`) como rede de segurança para jobs presos. O processamento contínuo depende do cron externo.

## 5. Variáveis de fila (opcional)

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `DISTRIBUTION_DELAY_MS` | `1000` | Delay entre leads (evita 429 no Kommo) |
| `DISTRIBUTION_MAX_JOBS_PER_RUN` | `10` | Jobs por invocação (cabe em 60s no Hobby) |
| `DISTRIBUTION_QUEUE_LOCK_TTL_MS` | `90000` | TTL do lock da fila |
| `DISTRIBUTION_STALE_JOB_MS` | `120000` | Jobs `processing` presos voltam para `pending` |

## Alternativas ao cron-job.org

- **GitHub Actions** — workflow `schedule: '*/1 * * * *'` com `curl` no endpoint
- **UptimeRobot / EasyCron** — mesmo padrão: GET + header `Authorization`
- **Worker Railway/Render** — script Node com `setInterval` de 30–60s
