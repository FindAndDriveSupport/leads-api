/**
 * Lead Sync: Seriti API → Kredo API → HubSpot
 *
 * HIGH INTENT flow:
 *   1. Auth Seriti → fetch high-intent leads
 *   2. Deduplicate by id_number in HubSpot
 *   3. Auth Kredo → run credit report → extract PredictedApproval
 *   4. Create/update HubSpot contact (6 fields) + deal tagged "High Intent"
 *
 * LOW INTENT flow:
 *   1. Auth Seriti → fetch low-intent leads
 *   2. Deduplicate by firstName + lastName + mobileNumber in HubSpot
 *   3. Create HubSpot contact (4 fields) + deal tagged "Low Intent"
 *   (No Kredo call for low-intent leads)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  seriti: {
    baseUrl: "https://seritiapi.findndrive.co.za",
    apiKey: process.env.SERITI_API_KEY,
    apiSecret: process.env.SERITI_API_SECRET,
    dealershipId: process.env.SERITI_DEALERSHIP_ID,
  },
  kredo: {
    baseUrl: "https://api.kredo.co.za",
    username: process.env.KREDO_USERNAME,
    password: process.env.KREDO_PASSWORD,
  },
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
    baseUrl: "https://api.hubapi.com",
    // ⚠️ Replace these with your actual HubSpot pipeline/stage IDs
    // Find them: HubSpot → Settings → CRM → Deals → Pipelines
    highIntent: {
      pipeline: "default",
      dealStage: "appointmentscheduled",
    },
    lowIntent: {
      pipeline: "default",
      dealStage: "qualifiedtobuy", // or whichever stage suits low-intent nurture
    },
  },
  processedIdsFile: path.join(__dirname, "..", "processed-leads.json"),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(level, message, data = null) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data && { data }),
  }));
}

function generateGuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${body.substring(0, 500)}`);
  try { return JSON.parse(body); }
  catch { throw new Error(`Non-JSON response from ${url}: ${body.substring(0, 200)}`); }
}

// ─── Processed IDs (local cache — guards against re-processing within a run) ──
// Primary deduplication for high-intent is HubSpot id_number lookup.
// Primary deduplication for low-intent is HubSpot name+phone lookup.
// This local cache is a fast pre-filter to avoid redundant HubSpot API calls
// for leads we definitely already processed in a previous run.

function loadProcessedIds() {
  try {
    if (fs.existsSync(CONFIG.processedIdsFile)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.processedIdsFile, "utf8"));
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const pruned = Object.fromEntries(
        Object.entries(data).filter(([, ts]) => ts > cutoff)
      );
      return new Set(Object.keys(pruned));
    }
  } catch (err) {
    log("warn", "Could not load processed IDs cache", { error: err.message });
  }
  return new Set();
}

function saveProcessedIds(ids) {
  const now = Date.now();
  const data = {};
  for (const id of ids) data[id] = now;
  fs.writeFileSync(CONFIG.processedIdsFile, JSON.stringify(data, null, 2));
}

// Stable cache key per lead type
function highIntentCacheKey(lead) {
  return `hi:${lead.idNumber}`;
}
function lowIntentCacheKey(lead) {
  const name = `${(lead.firstName || "").toLowerCase().trim()}`;
  const surname = `${(lead.lastName || "").toLowerCase().trim()}`;
  const phone = `${(lead.mobileNumber || "").replace(/\D/g, "")}`;
  return `lo:${name}:${surname}:${phone}`;
}

// ─── Seriti API ───────────────────────────────────────────────────────────────

async function getSeritiToken() {
  log("info", "Authenticating with Seriti API...");
  // ⚠️ Verify endpoint + body field names against your Swagger docs
  const data = await fetchJson(`${CONFIG.seriti.baseUrl}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: CONFIG.seriti.apiKey,
      apiSecret: CONFIG.seriti.apiSecret,
    }),
  });
  const token = data.token || data.access_token || data.bearerToken;
  if (!token) throw new Error("Seriti auth: no token — " + JSON.stringify(data));
  log("info", "Seriti token obtained");
  return token;
}

async function fetchLeads(token, intent) {
  // ⚠️ Verify the low-intent endpoint path against your Swagger docs
  const endpoint = intent === "high"
    ? `${CONFIG.seriti.baseUrl}/api/leads/high-intent?dealershipId=${CONFIG.seriti.dealershipId}`
    : `${CONFIG.seriti.baseUrl}/api/leads/low-intent?dealershipId=${CONFIG.seriti.dealershipId}`;

  log("info", `Fetching ${intent}-intent leads from Seriti...`);
  const data = await fetchJson(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  const leads = Array.isArray(data) ? data : data.leads || data.data || [];
  log("info", `Fetched ${leads.length} ${intent}-intent leads`);
  return leads;
}

// ─── Kredo API ────────────────────────────────────────────────────────────────

async function getKredoToken() {
  log("info", "Authenticating with Kredo API...");
  const data = await fetchJson(`${CONFIG.kredo.baseUrl}/private/client/user/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: CONFIG.kredo.username, password: CONFIG.kredo.password }),
  });
  const token = data.token || data.access_token || data.bearerToken;
  if (!token) throw new Error("Kredo auth: no token — " + JSON.stringify(data));
  log("info", "Kredo token obtained");
  return token;
}

function mapSeritiToKredo(lead) {
  return {
    client_guid: generateGuid(),
    consumer: {
      id_number:          lead.idNumber     || "",
      first_name:         lead.firstName    || "",
      last_name:          lead.lastName     || "",
      work_number:        "",
      cell_number:        lead.mobileNumber || "",
      email_address:      "leads@findndrive.co.za",
      gross_income:       String(lead.netIncome || "0"),
      household_expenses: 0,
      reason:             "Affordability Assessment",
      home_number:        "",
      consent:            true,
    },
  };
}

function extractPredictedApproval(kredoResponse) {
  const candidates = [
    kredoResponse?.PredictedApproval,
    kredoResponse?.predictedApproval,
    kredoResponse?.data?.PredictedApproval,
    kredoResponse?.data?.predictedApproval,
    kredoResponse?.report?.PredictedApproval,
    kredoResponse?.CreditReport?.PredictedApproval,
    kredoResponse?.creditReport?.PredictedApproval,
    kredoResponse?.result?.PredictedApproval,
  ];
  for (const val of candidates) {
    if (val !== undefined && val !== null && val !== "") return String(val);
  }
  log("warn", "PredictedApproval not found — check Kredo response structure", {
    topLevelKeys: Object.keys(kredoResponse || {}),
  });
  return "Unknown";
}

async function postToKredo(token, kredoPayload) {
  log("info", "Posting to Kredo credit-report-json...", { client_guid: kredoPayload.client_guid });
  const data = await fetchJson(`${CONFIG.kredo.baseUrl}/credit-report-json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(kredoPayload),
  });
  const predictedApproval = extractPredictedApproval(data);
  log("info", "Kredo response received", { client_guid: kredoPayload.client_guid, predictedApproval });
  return { raw: data, predictedApproval, client_guid: kredoPayload.client_guid };
}

// ─── HubSpot API ──────────────────────────────────────────────────────────────

/**
 * For HIGH INTENT: search by custom property `seriti_id_number`.
 * Returns contactId if found, null if not.
 */
async function findContactByIdNumber(idNumber) {
  if (!idNumber) return null;
  try {
    const res = await fetchJson(`${CONFIG.hubspot.baseUrl}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.hubspot.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: "seriti_id_number", operator: "EQ", value: idNumber }],
        }],
        properties: ["id"],
        limit: 1,
      }),
    });
    return res.results?.[0]?.id || null;
  } catch (err) {
    log("warn", "HubSpot id_number search failed", { error: err.message });
    return null;
  }
}

/**
 * For LOW INTENT: search by firstname + lastname + phone combination.
 * HubSpot doesn't support multi-field AND in one filter group for all field types,
 * so we search by phone first (most selective), then verify name client-side.
 * Returns contactId if a matching record exists, null if not.
 */
async function findContactByNameAndPhone(firstName, lastName, mobileNumber) {
  if (!mobileNumber) return null;
  const phone = mobileNumber.replace(/\D/g, "");
  try {
    const res = await fetchJson(`${CONFIG.hubspot.baseUrl}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.hubspot.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: "phone", operator: "EQ", value: mobileNumber }],
        }],
        properties: ["id", "firstname", "lastname", "phone"],
        limit: 10,
      }),
    });

    if (!res.results?.length) return null;

    // Verify first + last name match client-side
    const fn = (firstName || "").toLowerCase().trim();
    const ln = (lastName || "").toLowerCase().trim();

    const match = res.results.find((c) => {
      const hsFn = (c.properties?.firstname || "").toLowerCase().trim();
      const hsLn = (c.properties?.lastname || "").toLowerCase().trim();
      return hsFn === fn && hsLn === ln;
    });

    return match?.id || null;
  } catch (err) {
    log("warn", "HubSpot name+phone search failed", { error: err.message });
    return null;
  }
}

/**
 * HIGH INTENT: create or update contact with 6 fields + intent tag.
 */
async function upsertHighIntentContact(lead, kredoResult) {
  log("info", "Upserting high-intent HubSpot contact...", { idNumber: lead.idNumber });

  const existingId = await findContactByIdNumber(lead.idNumber);

  const properties = {
    firstname:                lead.firstName        || "",
    lastname:                 lead.lastName         || "",
    phone:                    lead.mobileNumber     || "",
    email:                    lead.email || `${lead.idNumber}@seriti-lead.local`,
    // Custom properties
    seriti_id_number:         lead.idNumber         || "",
    seriti_estimated_amount:  lead.estimatedAmount  || "",
    kredo_approval_chances:   kredoResult.predictedApproval,
    lead_intent:              "High Intent",
  };

  if (existingId) {
    await fetchJson(`${CONFIG.hubspot.baseUrl}/crm/v3/objects/contacts/${existingId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${CONFIG.hubspot.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    });
    log("info", "High-intent contact updated", { contactId: existingId });
    return { contactId: existingId, isNew: false };
  }

  const created = await fetchJson(`${CONFIG.hubspot.baseUrl}/crm/v3/objects/contacts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.hubspot.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  log("info", "High-intent contact created", { contactId: created.id });
  return { contactId: created.id, isNew: true };
}

/**
 * LOW INTENT: only create — never update — if name+phone combo is new.
 * Returns null if duplicate detected in HubSpot (skip this lead).
 */
async function createLowIntentContact(lead) {
  log("info", "Checking for low-intent duplicate in HubSpot...", {
    name: `${lead.firstName} ${lead.lastName}`,
  });

  const existingId = await findContactByNameAndPhone(
    lead.firstName,
    lead.lastName,
    lead.mobileNumber
  );

  if (existingId) {
    log("info", "Low-intent duplicate found in HubSpot — skipping", { contactId: existingId });
    return null;
  }

  const properties = {
    firstname:        lead.firstName    || "",
    lastname:         lead.lastName     || "",
    phone:            lead.mobileNumber || "",
    email:            lead.email || `lo.${(lead.mobileNumber || "unknown").replace(/\D/g,"")}@seriti-lead.local`,
    // Custom properties
    seriti_net_income: String(lead.netIncome || ""),
    lead_intent:       "Low Intent",
  };

  const created = await fetchJson(`${CONFIG.hubspot.baseUrl}/crm/v3/objects/contacts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.hubspot.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  log("info", "Low-intent contact created", { contactId: created.id });
  return created.id;
}

/**
 * Create a deal and associate it with the contact.
 */
async function createDeal(lead, contactId, intent, kredoResult = null) {
  const cfg = intent === "high" ? CONFIG.hubspot.highIntent : CONFIG.hubspot.lowIntent;
  const label = intent === "high" ? "High Intent" : "Low Intent";

  const dealProperties = {
    dealname:    `${lead.firstName || ""} ${lead.lastName || ""} — ${label} Lead`.trim(),
    pipeline:    cfg.pipeline,
    dealstage:   cfg.dealStage,
    amount:      String(lead.estimatedAmount || lead.netIncome || ""),
    lead_intent: label,
    ...(kredoResult && { kredo_approval_chances: kredoResult.predictedApproval }),
  };

  const deal = await fetchJson(`${CONFIG.hubspot.baseUrl}/crm/v3/objects/deals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.hubspot.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: dealProperties,
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
      }],
    }),
  });

  log("info", `${label} deal created`, { dealId: deal.id, contactId });
  return deal.id;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("info", "=== Lead sync starting ===");

  const required = [
    "SERITI_API_KEY", "SERITI_API_SECRET", "SERITI_DEALERSHIP_ID",
    "KREDO_USERNAME", "KREDO_PASSWORD", "HUBSPOT_ACCESS_TOKEN",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(", ")}`);

  const processedIds = loadProcessedIds();
  log("info", `Loaded ${processedIds.size} cached processed IDs`);

  // Auth: Seriti always needed; Kredo only for high-intent (fetched in parallel)
  const [seritiToken, kredoToken] = await Promise.all([
    getSeritiToken(),
    getKredoToken(),
  ]);

  // Fetch both lead types in parallel
  const [highLeads, lowLeads] = await Promise.all([
    fetchLeads(seritiToken, "high"),
    fetchLeads(seritiToken, "low"),
  ]);

  let successHigh = 0, successLow = 0, errorCount = 0;

  // ── HIGH INTENT ─────────────────────────────────────────────────────────────
  log("info", "--- Processing high-intent leads ---");

  for (const lead of highLeads) {
    const cacheKey = highIntentCacheKey(lead);

    // Fast pre-filter: skip if we cached this ID locally
    if (processedIds.has(cacheKey)) {
      log("info", `Skipping cached high-intent lead: ${lead.idNumber}`);
      continue;
    }

    try {
      const kredoPayload = mapSeritiToKredo(lead);
      const kredoResult  = await postToKredo(kredoToken, kredoPayload);

      // upsertHighIntentContact checks HubSpot by id_number (authoritative dedupe)
      const { contactId, isNew } = await upsertHighIntentContact(lead, kredoResult);

      // Only create a new deal if this is a new contact
      if (isNew) await createDeal(lead, contactId, "high", kredoResult);

      processedIds.add(cacheKey);
      successHigh++;
      log("info", `✓ High-intent lead processed: ${lead.idNumber}`);
    } catch (err) {
      errorCount++;
      log("error", `✗ High-intent lead failed: ${lead.idNumber}`, { error: err.message });
    }
  }

  // ── LOW INTENT ──────────────────────────────────────────────────────────────
  log("info", "--- Processing low-intent leads ---");

  for (const lead of lowLeads) {
    const cacheKey = lowIntentCacheKey(lead);

    // Fast pre-filter: skip if we cached this combo locally
    if (processedIds.has(cacheKey)) {
      log("info", `Skipping cached low-intent lead: ${lead.firstName} ${lead.lastName}`);
      continue;
    }

    try {
      // createLowIntentContact checks HubSpot by name+phone (authoritative dedupe)
      // Returns null if duplicate — skip silently
      const contactId = await createLowIntentContact(lead);

      if (contactId) {
        await createDeal(lead, contactId, "low");
        successLow++;
        log("info", `✓ Low-intent lead processed: ${lead.firstName} ${lead.lastName}`);
      }

      // Cache the key regardless — if it was a duplicate we still don't need
      // to hit HubSpot again for this combo next run
      processedIds.add(cacheKey);
    } catch (err) {
      errorCount++;
      log("error", `✗ Low-intent lead failed: ${lead.firstName} ${lead.lastName}`, { error: err.message });
    }
  }

  saveProcessedIds(processedIds);

  log("info", `=== Sync complete: ${successHigh} high-intent, ${successLow} low-intent, ${errorCount} errors ===`);
  if (errorCount > 0) process.exit(1);
}

main().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
