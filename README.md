# Seriti → Kredo → HubSpot Lead Sync

Cloudflare Worker (runs every 5 minutes via cron trigger) that polls Seriti for **high-intent** and **low-intent** leads, optionally runs Kredo credit checks per dealer, and creates categorised contacts in HubSpot.

---

## How it works

### High Intent
1. Fetch leads from Seriti high-intent endpoint
2. **Deduplicate via Cloudflare KV cache** — if the lead has been processed in the last 7 days, skip it
3. If `kredoEnabled: true` — run Kredo credit report → extract `PredictedApproval`
4. If `kredoEnabled: false` — use Seriti's `approvalChance` field directly
5. Create HubSpot contact with fields tagged `High Intent`

### Low Intent
1. Fetch leads from Seriti low-intent endpoint
2. **Deduplicate via Cloudflare KV cache** — 7-day TTL, auto-expires
3. Create HubSpot contact with fields tagged `Low Intent`
4. No Kredo call (affordability check not run for low-intent)

---

## Architecture

- **Runtime**: Cloudflare Worker (no Node.js — uses native `fetch` and `crypto`)
- **Schedule**: Cron trigger `*/5 * * * *` (every 5 minutes)
- **Dealer config**: Stored in `LEADS_SYNC_CONFIG` KV — one entry per dealer
- **Deduplication cache**: `LEADS_SYNC_CACHE` KV — 7-day TTL per lead, auto-expires
- **Multi-dealer**: Worker iterates all keys in `LEADS_SYNC_CONFIG` on each tick
- **Manual trigger**: `GET /run` on the Worker URL triggers an immediate sync

---

## Setup Guide

### 1. Create KV Namespaces

```bash
npx wrangler kv namespace create LEADS_SYNC_CONFIG
npx wrangler kv namespace create LEADS_SYNC_CACHE
```

Copy the IDs returned and paste them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "LEADS_SYNC_CONFIG"
id = "YOUR_CONFIG_KV_ID"

[[kv_namespaces]]
binding = "LEADS_SYNC_CACHE"
id = "YOUR_CACHE_KV_ID"
```

### 2. Deploy the Worker

```bash
npx wrangler deploy
```

### 3. Add Dealer Config to KV

One entry per dealer. All credentials are stored here — no environment variables or GitHub Secrets needed.

```bash
npx wrangler kv key put --binding=LEADS_SYNC_CONFIG "keitzman-finance" '{
  "key": "keitzman-finance",
  "seritiApiKey": "YOUR_SERITI_API_KEY",
  "seritiApiSecret": "YOUR_SERITI_API_SECRET",
  "seritiDealershipId": "YOUR_DEALERSHIP_ID",
  "kredoEnabled": false,
  "kredoUsername": "",
  "kredoPassword": "",
  "kredoXApiKey": "",
  "hubspotToken": "YOUR_HUBSPOT_TOKEN",
  "startDate": "2026-05-22"
}'
```

Set `kredoEnabled: true` and fill in the Kredo fields to enable Kredo credit checks for that dealer.

### 4. HubSpot Private App

Settings → **Integrations → Private Apps → Create a private app**

Required scopes:
- `crm.objects.contacts.read`
- `crm.objects.contacts.write`

### 5. HubSpot Custom Properties

#### Contact Properties
Settings → **Properties → Contact properties → Create property**

| Internal name             | Label              | Type             | Used for    |
|---------------------------|--------------------|------------------|-------------|
| `seriti_id_number`        | ID Number          | Single-line text | High Intent |
| `estimated_finance`       | Estimated Finance  | Single-line text | High Intent |
| `kredo_predicted_approval`| Approval Chances   | Single-line text | High Intent |
| `seriti_net_income`       | Net Income         | Single-line text | Low Intent  |
| `lead_intent`             | Lead Intent        | Single-line text | Both        |
| `seriti_dealer_name`      | Dealer Name        | Single-line text | Both        |
| `seriti_dealer_code`      | Dealer Code        | Single-line text | Both        |
| `seriti_lead_date`        | Lead Date          | Single-line text | Both        |

> **`lead_intent`** will contain either `"High Intent"` or `"Low Intent"` — use this to filter your HubSpot views and lists.

### 6. Verify Seriti Endpoints

| Intent      | Method | Path                                                                        |
|-------------|--------|-----------------------------------------------------------------------------|
| Auth        | POST   | `/api/Authentication/token`                                                 |
| High intent | GET    | `/api/Leads/highIntent/{dealershipId}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` |
| Low intent  | GET    | `/api/Leads/lowIntent/{dealershipId}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` |

---

## Field Mapping

### High Intent → HubSpot

| Source | API Field        | HubSpot Property            | Type     |
|--------|------------------|-----------------------------|----------|
| Seriti | `firstName`      | First name *(built-in)*     | Standard |
| Seriti | `lastName`       | Last name *(built-in)*      | Standard |
| Seriti | `mobileNumber`   | Phone *(built-in)*          | Standard |
| Seriti | `idNumber`       | `seriti_id_number`          | Custom   |
| Seriti | `estimatedAmount`| `estimated_finance`         | Custom   |
| Seriti | `approvalChance` | `kredo_predicted_approval`  | Custom   |
| Kredo  | `PredictedApproval` | `kredo_predicted_approval` | Custom  |
| Seriti | `dealerName`     | `seriti_dealer_name`        | Custom   |
| Seriti | `dealerCode`     | `seriti_dealer_code`        | Custom   |
| Seriti | `date`           | `seriti_lead_date`          | Custom   |
| System | —                | `lead_intent` = High Intent | Custom   |

> When `kredoEnabled: false`, `approvalChance` from Seriti is used. When `kredoEnabled: true`, Kredo's `PredictedApproval` takes precedence.

### Low Intent → HubSpot

| Source | API Field      | HubSpot Property        | Type     |
|--------|----------------|-------------------------|----------|
| Seriti | `firstName`    | First name *(built-in)* | Standard |
| Seriti | `lastName`     | Last name *(built-in)*  | Standard |
| Seriti | `mobileNumber` | Phone *(built-in)*      | Standard |
| Seriti | `netIncome`    | `seriti_net_income`     | Custom   |
| Seriti | `dealerName`   | `seriti_dealer_name`    | Custom   |
| Seriti | `dealerCode`   | `seriti_dealer_code`    | Custom   |
| Seriti | `date`         | `seriti_lead_date`      | Custom   |
| System | —              | `lead_intent` = Low Intent | Custom |

---

## Deduplication Logic

Deduplication uses **Cloudflare KV** with a 7-day TTL — no manual cleanup needed.

| Intent      | Cache key                                     | Behaviour on duplicate  |
|-------------|-----------------------------------------------|-------------------------|
| High Intent | `{dealerKey}-highIntent-{idNumber}-{date}`    | Skip entirely           |
| Low Intent  | `{dealerKey}-lowIntent-{idNumber}-{date}`     | Skip entirely           |

---

## Adding More Dealers

Add a new KV entry for each dealer — the worker picks it up automatically on the next cron tick:

```bash
npx wrangler kv key put --binding=LEADS_SYNC_CONFIG "new-dealer-key" '{...}'
```

---

## Kredo Toggle

Kredo is configured **per dealer** in the KV config:

| `kredoEnabled` | Approval chances source                      |
|----------------|----------------------------------------------|
| `false`        | Seriti `approvalChance` field (no API call)  |
| `true`         | Kredo `PredictedApproval` (credit report run)|

---

## Segmenting Leads in HubSpot

Use the `lead_intent` contact property to build:
- **Active lists** — e.g. "All High Intent Leads", "All Low Intent Leads"
- **Views** — filter your contacts/deals board by `lead_intent`
- **Workflows** — trigger different nurture sequences per intent level
- **Reports** — compare conversion rates between intent tiers

---

## Monitoring

View live logs:
```bash
npx wrangler tail
```

Trigger a manual sync (useful for testing):
```
GET https://leads-api.YOUR_SUBDOMAIN.workers.dev/run
```

---

## Security Notes

- All credentials stored in Cloudflare KV — never in code or logs
- PII is not logged — only cache keys and contact IDs appear in logs
- All API calls use HTTPS
- Seriti tokens fetched fresh on every run — no long-lived tokens stored
- KV values should be treated as secrets — restrict Cloudflare account access accordingly
