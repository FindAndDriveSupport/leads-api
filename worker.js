/**
 * leads-api — Cloudflare Worker
 * Cron: every 5 minutes
 * Syncs Seriti high/low intent leads → HubSpot per dealer.
 * Dealer configs stored in LEADS_SYNC_CONFIG KV.
 * Processed lead cache stored in LEADS_SYNC_CACHE KV (7-day TTL).
 */

import crypto from "node:crypto";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  // Allow manual trigger via HTTP GET /run
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/run") {
      ctx.waitUntil(runSync(env));
      return new Response("Sync triggered", { status: 200 });
    }
    return new Response("leads-api worker", { status: 200 });
  },
};

// ─── Main sync ────────────────────────────────────────────────────────────────
async function runSync(env) {
  console.log("🚀 Lead sync starting...");

  // Load all dealer configs from KV
  const { keys } = await env.LEADS_SYNC_CONFIG.list();
  if (!keys.length) {
    console.log("ℹ️  No dealer configs found in LEADS_SYNC_CONFIG KV.");
    return;
  }

  for (const { name } of keys) {
    const raw = await env.LEADS_SYNC_CONFIG.get(name);
    if (!raw) continue;

    let dealer;
    try {
      dealer = JSON.parse(raw);
    } catch {
      console.error(`❌ Invalid JSON for dealer config: ${name}`);
      continue;
    }

    console.log(`\n── Dealer: ${dealer.key} ─────────────────────────────`);
    try {
      await syncDealer(dealer, env);
    } catch (err) {
      console.error(`❌ Fatal error for dealer ${dealer.key}:`, err.message);
    }
  }

  console.log("\n✅ Sync complete.");
}

// ─── Per-dealer sync ──────────────────────────────────────────────────────────
async function syncDealer(dealer, env) {
  const {
    key,
    seritiApiKey,
    seritiApiSecret,
    seritiDealershipId,
    kredoEnabled = false,
    kredoUsername,
    kredoPassword,
    kredoXApiKey,
    hubspotToken,
    startDate = "2026-05-22",
  } = dealer;

  // Authenticate with Seriti
  const seritiToken = await getSeritiToken(seritiApiKey, seritiApiSecret);

  // Fetch both intent lists in parallel
  const [highLeads, lowLeads] = await Promise.all([
    fetchSeritiLeads("highIntent", seritiDealershipId, startDate, seritiToken),
    fetchSeritiLeads("lowIntent", seritiDealershipId, startDate, seritiToken),
  ]);

  // High intent
  console.log(`\n── High Intent (${highLeads.length} leads) ──`);
  const high = await processLeads(highLeads, "highIntent", key, env, true, {
    kredoEnabled, kredoUsername, kredoPassword, kredoXApiKey, hubspotToken,
  });

  // Low intent
  console.log(`\n── Low Intent (${lowLeads.length} leads) ──`);
  const low = await processLeads(lowLeads, "lowIntent", key, env, false, {
    kredoEnabled: false, hubspotToken,
  });

  console.log(`
📊 ${key} Summary
   High intent — New: ${high.newCount} | Skipped: ${high.skippedCount} | Errors: ${high.errorCount}
   Low intent  — New: ${low.newCount} | Skipped: ${low.skippedCount} | Errors: ${low.errorCount}
  `);
}

// ─── Process leads ────────────────────────────────────────────────────────────
async function processLeads(leads, intent, dealerKey, env, runKredo, opts) {
  let newCount = 0, skippedCount = 0, errorCount = 0;

  for (const lead of leads) {
    const cacheKey = `${dealerKey}-${intent}-${lead.idNumber}-${lead.date}`;

    // Check KV cache (7-day TTL set on write)
    const cached = await env.LEADS_SYNC_CACHE.get(cacheKey);
    if (cached) {
      skippedCount++;
      continue;
    }

    console.log(`\n👤 [${intent}] ${lead.firstName} ${lead.lastName}`);

    try {
      let approvalChance = lead.approvalChance ?? "";

      if (runKredo && opts.kredoEnabled) {
        const kredoResult = await submitToKredo(lead, opts);
        approvalChance = String(
          kredoResult?.data?.report?.predictor?.vehicle_asset_finance?.PredictedApproval ?? approvalChance
        );
      }

      await createHubSpotContact(lead, intent, approvalChance, opts.hubspotToken);

      // Cache with 7-day TTL (604800 seconds)
      await env.LEADS_SYNC_CACHE.put(cacheKey, "1", { expirationTtl: 604800 });
      newCount++;
    } catch (err) {
      console.error(`  ❌ Failed for ${cacheKey}:`, err.message);
      errorCount++;
      // Cache failed leads with 1-day TTL to prevent infinite retry loops
      // on non-retryable errors (e.g. missing HubSpot properties)
      await env.LEADS_SYNC_CACHE.put(cacheKey, "error", { expirationTtl: 86400 });
    }
  }

  return { newCount, skippedCount, errorCount };
}

// ─── Seriti auth ──────────────────────────────────────────────────────────────
async function getSeritiToken(apiKey, apiSecret) {
  console.log("🔑 Authenticating with Seriti...");
  const res = await fetch("https://seritiapi.findndrive.co.za/api/Authentication/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ApiKeyId: apiKey, ApiSecret: apiSecret }),
  });
  if (!res.ok) throw new Error(`Seriti auth failed: ${res.status}`);
  const data = await res.json();
  const token = data.token || data.access_token || data.accessToken;
  if (!token) throw new Error(`Seriti auth — no token in response: ${JSON.stringify(data)}`);
  console.log("✅ Seriti token acquired.");
  return token;
}

// ─── Seriti fetch leads ───────────────────────────────────────────────────────
async function fetchSeritiLeads(intent, dealershipId, startDate, token) {
  const endDate = new Date().toISOString().slice(0, 10);
  console.log(`📡 Fetching ${intent} leads (${startDate} → ${endDate})...`);
  const res = await fetch(
    `https://seritiapi.findndrive.co.za/api/Leads/${intent}/${dealershipId}?startDate=${startDate}&endDate=${endDate}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );
  if (!res.ok) throw new Error(`Seriti leads fetch failed: ${res.status}`);
  const leads = await res.json();
  console.log(`✅ ${leads.length} ${intent} lead(s) returned.`);
  return leads;
}

// ─── Kredo credit check ───────────────────────────────────────────────────────
async function submitToKredo(lead, opts) {
  console.log(`  🔍 Submitting ${lead.firstName} ${lead.lastName} to Kredo...`);

  const authRes = await fetch("https://api.kredo.co.za/private/client/user/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.kredoXApiKey,
    },
    body: JSON.stringify({ username: opts.kredoUsername, password: opts.kredoPassword }),
  });
  if (!authRes.ok) throw new Error(`Kredo auth failed: ${authRes.status}`);
  const authData = await authRes.json();
  const kredoToken = authData.authorizationToken || authData.token || authData.access_token;
  if (!kredoToken) throw new Error(`Kredo auth — no token: ${JSON.stringify(authData)}`);

  const creditRes = await fetch("https://api.kredo.co.za/credit-report-json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.kredoXApiKey,
      "authorizationToken": kredoToken,
    },
    body: JSON.stringify({
      client_guid: crypto.randomUUID(),
      consumer: {
        id_number:          lead.idNumber,
        first_name:         lead.firstName,
        last_name:          lead.lastName,
        cell_number:        lead.mobileNumber,
        work_number:        "",
        home_number:        "",
        email_address:      "",
        gross_income:       Number(lead.netIncome) || 0,
        household_expenses: 0,
        reason:             "Affordability Assessment",
        consent:            true,
      },
    }),
  });
  if (!creditRes.ok) throw new Error(`Kredo credit report failed: ${creditRes.status}`);
  const result = await creditRes.json();
  console.log(`  ✅ Kredo report received.`);
  return result;
}

// ─── HubSpot contact creation ─────────────────────────────────────────────────
async function createHubSpotContact(lead, intent, approvalChance, hubspotToken) {
  console.log(`  📬 Creating HubSpot contact for ${lead.firstName} ${lead.lastName} [${intent}]...`);

  // Check if contact already exists by mobile
  const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hubspotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [{
        filters: [{
          propertyName: "mobilephone",
          operator: "EQ",
          value: lead.mobileNumber,
        }],
      }],
      properties: ["id", "mobilephone"],
      limit: 1,
    }),
  });
  const searchData = await searchRes.json();
  if (searchData.total > 0) {
    console.log(`  ⏭️  Contact already exists (mobile: ${lead.mobileNumber}), skipping.`);
    return null;
  }

  const properties = {
    firstname:          lead.firstName,
    lastname:           lead.lastName,
    mobilephone:        lead.mobileNumber,
    seriti_dealer_name: lead.dealerName,
    seriti_dealer_code: lead.dealerCode,
    seriti_lead_date:   lead.date,
  };

  if (intent === "highIntent") {
    properties.seriti_id_number         = lead.idNumber ?? "";
    properties.estimated_finance        = lead.estimatedAmount ?? "";
    properties.kredo_predicted_approval = approvalChance;
  } else {
    properties.seriti_net_income = lead.netIncome ?? "";
  }

  const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hubspotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`HubSpot contact creation failed: ${createRes.status} — ${err}`);
  }

  const contact = await createRes.json();
  console.log(`  ✅ HubSpot contact created: ID ${contact.id}`);
  return contact;
}