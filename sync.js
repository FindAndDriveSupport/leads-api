import fs from "fs";
import https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────
const SERITI_API_KEY       = process.env.SERITI_API_KEY;
const SERITI_API_SECRET    = process.env.SERITI_API_SECRET;
const SERITI_DEALERSHIP_ID = process.env.SERITI_DEALERSHIP_ID;
const KREDO_USERNAME       = process.env.KREDO_USERNAME;
const KREDO_PASSWORD       = process.env.KREDO_PASSWORD;
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

const PROCESSED_FILE    = "processed-leads.json";
const SERITI_START_DATE = "2026-05-22";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const raw = fs.readFileSync(PROCESSED_FILE, "utf8");
      return new Set(JSON.parse(raw));
    }
  } catch (e) {
    console.warn("⚠️  Could not read processed-leads.json, starting fresh.", e.message);
  }
  return new Set();
}

function saveProcessedIds(ids) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...ids]), "utf8");
}

function makeLeadId(lead, intent) {
  return `${intent}-${lead.idNumber}-${lead.date}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── Step 0: Authenticate with Seriti ────────────────────────────────────────
async function getSeritiToken() {
  console.log("🔑 Authenticating with Seriti...");

  const response = await request(
    "https://seritiapi.findndrive.co.za/api/Authentication/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    {
      ApiKeyId:     SERITI_API_KEY,
      ApiSecret:    SERITI_API_SECRET,
    }
  );

  const token = response.token || response.access_token || response.accessToken;
  if (!token) throw new Error(`Seriti auth failed — no token in response: ${JSON.stringify(response)}`);

  console.log("✅ Seriti token acquired.");
  return token;
}

// ─── Step 1: Fetch leads from Seriti ─────────────────────────────────────────
async function fetchSeritiLeads(intent, token) {
  const endDate = todayISO();
  console.log(`📡 Fetching ${intent} leads from Seriti (${SERITI_START_DATE} → ${endDate})...`);

  const leads = await request(
    `https://seritiapi.findndrive.co.za/api/Leads/${intent}/${SERITI_DEALERSHIP_ID}?startDate=${SERITI_START_DATE}&endDate=${endDate}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  console.log(`✅ Seriti returned ${leads.length} ${intent} lead(s).`);
  return leads;
}

// ─── Step 2: Kredo credit check (high intent only) ───────────────────────────
async function submitToKredo(lead) {
  console.log(`  🔍 Submitting ${lead.firstName} ${lead.lastName} to Kredo...`);

  const authResponse = await request(
    "https://api.kredo.co.za/v1/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    {
      username: KREDO_USERNAME,
      password: KREDO_PASSWORD,
    }
  );

  const kredoToken = authResponse.token || authResponse.access_token;
  if (!kredoToken) throw new Error("Kredo auth failed — no token returned.");

  const kredoResult = await request(
    "https://api.kredo.co.za/v1/credit-check",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kredoToken}`,
        "Content-Type": "application/json",
      },
    },
    {
      id_number:  lead.idNumber,
      first_name: lead.firstName,
      last_name:  lead.lastName,
      mobile:     lead.mobileNumber,
      net_income: lead.netIncome,
    }
  );

  console.log(`  ✅ Kredo result: score=${kredoResult.score ?? "N/A"}, status=${kredoResult.status ?? "N/A"}`);
  return kredoResult;
}

// ─── Step 3: Create contact in HubSpot ───────────────────────────────────────
async function createHubSpotContact(lead, intent, kredoResult = null) {
  console.log(`  📬 Creating HubSpot contact for ${lead.firstName} ${lead.lastName} [${intent}]...`);

  // Check if contact already exists by phone
  const searchResult = await request(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
    {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "phone",
              operator: "EQ",
              value: lead.mobileNumber,
            },
          ],
        },
      ],
      properties: ["id", "phone", "firstname", "lastname"],
      limit: 1,
    }
  );

  if (searchResult.total > 0) {
    console.log(`  ⏭️  Contact already exists in HubSpot (phone: ${lead.mobileNumber}), skipping.`);
    return null;
  }

  const properties = {
    firstname:                lead.firstName,
    lastname:                 lead.lastName,
    phone:                    lead.mobileNumber,
    seriti_dealer_name:       lead.dealerName,
    seriti_dealer_code:       lead.dealerCode,
    seriti_lead_date:         lead.date,
    seriti_approval_chance:   lead.approvalChance,
    seriti_estimated_amount:  lead.estimatedAmount,
    seriti_instalment_budget: lead.instalmentBudget,
    seriti_insurance_budget:  lead.insuranceBudget,
    seriti_contact_ability:   lead.contactAbility,
    seriti_id_number:         lead.idNumber,
    seriti_net_income:        lead.netIncome,
    seriti_intent:            intent,
  };

  if (kredoResult) {
    properties.kredo_credit_score  = String(kredoResult?.score ?? "");
    properties.kredo_credit_status = String(kredoResult?.status ?? "");
    properties.kredo_affordability = String(kredoResult?.affordability ?? "");
  }

  const contact = await request(
    "https://api.hubapi.com/crm/v3/objects/contacts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
    { properties }
  );

  console.log(`  ✅ HubSpot contact created: ID ${contact.id}`);
  return contact;
}

// ─── Process a batch of leads ─────────────────────────────────────────────────
async function processLeads(leads, intent, processedIds, runKredo) {
  let newCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const lead of leads) {
    const leadId = makeLeadId(lead, intent);

    if (processedIds.has(leadId)) {
      skippedCount++;
      continue;
    }

    console.log(`\n👤 Processing [${intent}]: ${lead.firstName} ${lead.lastName} (${leadId})`);

    try {
      let kredoResult = null;
      if (runKredo) {
        kredoResult = await submitToKredo(lead);
      }

      await createHubSpotContact(lead, intent, kredoResult);
      processedIds.add(leadId);
      newCount++;
    } catch (err) {
      console.error(`  ❌ Failed for ${leadId}:`, err.message);
      errorCount++;
    }
  }

  return { newCount, skippedCount, errorCount };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Lead sync starting...\n");

  const required = {
    SERITI_API_KEY,
    SERITI_API_SECRET,
    SERITI_DEALERSHIP_ID,
    KREDO_USERNAME,
    KREDO_PASSWORD,
    HUBSPOT_ACCESS_TOKEN,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const processedIds = loadProcessedIds();

  // Authenticate with Seriti once, reuse token for both requests
  const seritiToken = await getSeritiToken();

  // Fetch both intent lists in parallel
  const [highLeads, lowLeads] = await Promise.all([
    fetchSeritiLeads("highIntent", seritiToken),
    fetchSeritiLeads("lowIntent", seritiToken),
  ]);

  // High intent → Kredo + HubSpot
  console.log("\n── High Intent ──────────────────────────────────────────");
  const high = await processLeads(highLeads, "highIntent", processedIds, true);

  // Low intent → HubSpot only
  console.log("\n── Low Intent ───────────────────────────────────────────");
  const low = await processLeads(lowLeads, "lowIntent", processedIds, false);

  saveProcessedIds(processedIds);

  console.log(`
📊 Summary
   High intent — New: ${high.newCount} | Skipped: ${high.skippedCount} | Errors: ${high.errorCount}
   Low intent  — New: ${low.newCount} | Skipped: ${low.skippedCount} | Errors: ${low.errorCount}
  `);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
