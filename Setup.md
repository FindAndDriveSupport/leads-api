# leads-api Cloudflare Worker — Setup

## 1. Create KV namespaces

```bash
npx wrangler kv namespace create LEADS_SYNC_CONFIG
npx wrangler kv namespace create LEADS_SYNC_CACHE
```

Copy the IDs returned and paste into wrangler.toml replacing REPLACE_WITH_CONFIG_KV_ID and REPLACE_WITH_CACHE_KV_ID.

## 2. Deploy the worker

```bash
npx wrangler deploy
```

## 3. Add dealer config to KV

Replace values with real credentials:

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

To enable Kredo for a dealer, set kredoEnabled to true and fill in the Kredo fields.

## 4. Test manually

Visit: https://leads-api.YOUR_SUBDOMAIN.workers.dev/run

This triggers a sync immediately without waiting for the cron.

## 5. View logs

```bash
npx wrangler tail
```

## Adding more dealers

Just add another KV entry:

```bash
npx wrangler kv key put --binding=LEADS_SYNC_CONFIG "new-dealer-key" '{...}'
```

The worker automatically picks up all keys in LEADS_SYNC_CONFIG on each cron tick.
