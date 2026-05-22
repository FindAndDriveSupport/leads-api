import fs from "fs";
import https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────
const SERITI_API_KEY       = process.env.SERITI_API_KEY;
const SERITI_API_SECRET    = process.env.SERITI_API_SECRET;
const SERITI_DEALERSHIP_ID = process.env.SERITI_DEALERSHIP_ID;
const KREDO_USERNAME       = process.env.KREDO_USERNAME;
const KREDO_PASSWORD       = process.env.KREDO_PASSWORD;
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

const PROCESSED_FILE = "processed-leads.json";
const SERITI_START_DATE = "2026-05-22"; // Fixed start date — fetch all leads from this date onwards

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

function makeLeadId(lead) {
  // Seriti has no explicit ID field — compose one from idNumber + date
  return `${lead.idNumber}-${lead.date}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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

// ─── Step 1: Fetch leads from Seriti ─────────────────────────────────────────
async function fetchSeritiLeads() {
  const endDate = todayISO();
  console.log(`📡 Fetching leads from Seriti (${SERITI_START_DATE} → ${endDate})...`);

  const credentials = Buffer.from(`${SERITI_API_KEY}:${SERITI_API_SECRET}`).toString("base64");

  const leads = await request(
    `https://seritiapi.findndrive.co.za/api/leads?dealershipId=${SERITI_DEALERSHIP_ID}&startDate=${SERITI_START_DATE}&endDate=${endDate}`,
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
    }
  );

  console.log(`✅ Seriti returned ${leads.length} lead(s).`);
  return leads;
}

// ─── Step 2: Submit to Kredo for credit check ─────────────────────────────────
async function submitToKredo(lead) {
  console.log(`  🔍 Submitting ${lead.firstName} ${lead.lastName} to Kredo...`);

  // Step 2a: Authenticate with Kredo
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

  // Step 2b: Submit credit check
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
async function createHubSpotContact(lead, kredoResult) {
  console.log(`  📬 Creating HubSpot contact for ${lead.firstName} ${lead.lastName}...`);

  // Check if contact already exists by phone (Seriti returns no email)
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

  const contact = await request(
    "https://api.hubapi.com/crm/v3/objects/contacts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
    {
      properties: {
        firstname:                lead.firstName,
        lastname:                 lead.lastName,
        phone:                    lead.mobileNumber,
        // Seriti fields — create these as custom contact properties in HubSpot
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
        // Kredo fields — create these as custom contact properties in HubSpot
        kredo_credit_score:       String(kredoResult?.score ?? ""),
        kredo_credit_status:      String(kredoResult?.status ?? ""),
        kredo_affordability:      String(kredoResult?.affordability ?? ""),
      },
    }
  );

  console.log(`  ✅ HubSpot contact created: ID ${contact.id}`);
  return contact;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Lead sync starting...\n");

  // Validate env vars
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
  const leads = await fetchSeritiLeads();

  let newCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const lead of leads) {
    const leadId = makeLeadId(lead);

    if (processedIds.has(leadId)) {
      skippedCount++;
      continue;
    }

    console.log(`\n👤 Processing: ${lead.firstName} ${lead.lastName} (${leadId})`);

    try {
      const kredoResult = await submitToKredo(lead);
      await createHubSpotContact(lead, kredoResult);
      processedIds.add(leadId);
      newCount++;
    } catch (err) {
      console.error(`  ❌ Failed for ${leadId}:`, err.message);
      errorCount++;
      // Don't add to processedIds so it retries next run
    }
  }

  saveProcessedIds(processedIds);

  console.log(`\n📊 Done. New: ${newCount} | Skipped: ${skippedCount} | Errors: ${errorCount}`);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
