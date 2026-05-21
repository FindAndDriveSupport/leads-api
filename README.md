# Seriti → Kredo → HubSpot Lead Sync

GitHub Actions workflow (runs every 5 minutes) that polls Seriti for **high-intent** and **low-intent** leads, runs Kredo credit checks for high-intent leads, and creates categorised contacts + deals in HubSpot.

---

## How it works

### High Intent
1. Fetch leads from Seriti high-intent endpoint
2. **Deduplicate by `seriti_id_number`** — if a contact with that ID already exists in HubSpot, update it (no new deal created)
3. Run Kredo credit report → extract `PredictedApproval`
4. Create/update HubSpot contact with 6 fields, tagged `High Intent`
5. Create a linked deal in the High Intent pipeline stage

### Low Intent
1. Fetch leads from Seriti low-intent endpoint
2. **Deduplicate by firstName + lastName + mobileNumber** — if that combination already exists in HubSpot, skip entirely
3. Create HubSpot contact with 4 fields, tagged `Low Intent`
4. Create a linked deal in the Low Intent pipeline stage
5. No Kredo call (affordability check not run for low-intent)

---

## Setup Guide

### 1. GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret Name            | Value                              |
|------------------------|------------------------------------|
| `SERITI_API_KEY`       | Seriti API key                     |
| `SERITI_API_SECRET`    | Seriti API secret                  |
| `SERITI_DEALERSHIP_ID` | Your dealership ID                 |
| `KREDO_USERNAME`       | Kredo username                     |
| `KREDO_PASSWORD`       | Kredo password                     |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot Private App token          |

### 2. HubSpot Private App

Settings → **Integrations → Private Apps → Create a private app**

Required scopes:
- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.objects.deals.read`
- `crm.objects.deals.write`

### 3. HubSpot Custom Properties

#### Contact Properties
Settings → **Properties → Contact properties → Create property**

| Internal name            | Label              | Type              | Used for        |
|--------------------------|--------------------|-------------------|-----------------|
| `seriti_id_number`       | ID Number          | Single-line text  | High Intent     |
| `seriti_estimated_amount`| Estimated Finance  | Single-line text  | High Intent     |
| `kredo_approval_chances` | Approval Chances   | Single-line text  | High Intent     |
| `seriti_net_income`      | Net Income         | Single-line text  | Low Intent      |
| `lead_intent`            | Lead Intent        | Single-line text  | Both            |

> **`lead_intent`** will contain either `"High Intent"` or `"Low Intent"` — use this to filter your HubSpot views and lists.

#### Deal Properties (optional)
Same path — **Deal properties → Create property**

| Internal name            | Label              | Type              |
|--------------------------|--------------------|-------------------|
| `lead_intent`            | Lead Intent        | Single-line text  |
| `kredo_approval_chances` | Approval Chances   | Single-line text  |

### 4. HubSpot Pipeline/Stage IDs

Update `src/sync.js` lines with your real IDs:

```js
highIntent: {
  pipeline:  "default",              // ← your pipeline ID
  dealStage: "appointmentscheduled", // ← your high-intent stage ID
},
lowIntent: {
  pipeline:  "default",              // ← your pipeline ID
  dealStage: "qualifiedtobuy",       // ← your low-intent stage ID
},
```

Find IDs: Settings → CRM → Deals → Pipelines → click a stage → copy ID from URL.

### 5. Verify Seriti Endpoints

Confirm these paths against your Swagger docs and update `src/sync.js` if different:

| Intent      | Method | Path                                              |
|-------------|--------|---------------------------------------------------|
| Auth        | POST   | `/api/auth/token`                                 |
| High intent | GET    | `/api/leads/high-intent?dealershipId=XXX`         |
| Low intent  | GET    | `/api/leads/low-intent?dealershipId=XXX`          |

---

## Field Mapping

### High Intent → HubSpot

| Source  | API Field          | HubSpot Property           | Type     |
|---------|--------------------|----------------------------|----------|
| Seriti  | `firstName`        | First name *(built-in)*    | Standard |
| Seriti  | `lastName`         | Last name *(built-in)*     | Standard |
| Seriti  | `mobileNumber`     | Phone *(built-in)*         | Standard |
| Seriti  | `idNumber`         | `seriti_id_number`         | Custom   |
| Seriti  | `estimatedAmount`  | `seriti_estimated_amount`  | Custom   |
| Kredo   | `PredictedApproval`| `kredo_approval_chances`   | Custom   |
| System  | —                  | `lead_intent` = High Intent| Custom   |

### Low Intent → HubSpot

| Source  | API Field          | HubSpot Property           | Type     |
|---------|--------------------|----------------------------|----------|
| Seriti  | `firstName`        | First name *(built-in)*    | Standard |
| Seriti  | `lastName`         | Last name *(built-in)*     | Standard |
| Seriti  | `mobileNumber`     | Phone *(built-in)*         | Standard |
| Seriti  | `netIncome`        | `seriti_net_income`        | Custom   |
| System  | —                  | `lead_intent` = Low Intent | Custom   |

---

## Deduplication Logic

| Intent      | Dedupe key                              | Behaviour on duplicate          |
|-------------|-----------------------------------------|---------------------------------|
| High Intent | `seriti_id_number` (HubSpot lookup)     | Update contact, skip new deal   |
| Low Intent  | `firstName + lastName + mobileNumber`   | Skip entirely — not stored      |

Both types also maintain a local 7-day cache of processed lead keys to avoid redundant HubSpot API calls on re-runs.

---

## Segmenting Leads in HubSpot

Use the `lead_intent` contact property to build:
- **Active lists** — e.g. "All High Intent Leads", "All Low Intent Leads"
- **Views** — filter your contacts/deals board by `lead_intent`
- **Workflows** — trigger different nurture sequences per intent level
- **Reports** — compare conversion rates between intent tiers

---

## Security Notes

- All credentials in GitHub Secrets — never in code or logs
- PII is not logged — only IDs and GUIDs appear in GitHub Actions logs
- All API calls use HTTPS
- Tokens refreshed on every run — no long-lived tokens stored
