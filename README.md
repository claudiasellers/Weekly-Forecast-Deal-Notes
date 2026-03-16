# TMT Deal Notes — Slack Canvas Automation

Automatically reads deal data from a Google Sheet and creates a formatted Slack
Canvas each week with deal cards for sales leader review.

---

## Architecture

```
┌─────────────────────┐
│  Scheduled trigger   │──── Every Thursday 9 AM ET
│  or Link trigger     │──── On-demand click
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│  Deno Workflow       │
│  (Slack-hosted)      │
└─────────┬───────────┘
          ▼
┌─────────────────────────────────────────────┐
│  Custom Function (TypeScript)               │
│                                             │
│  1. fetch() → Google Sheets API             │
│     (Service Account auth via JWT)          │
│                                             │
│  2. Parse rows → detect section headers     │
│     → group deals into Q1 / Monthly         │
│                                             │
│  3. Parse Concat column → extract team,     │
│     financials (OP, IN, UP+, UP-, DC)       │
│                                             │
│  4. Build markdown → TOC + deal cards       │
│                                             │
│  5. canvases.create → new Slack Canvas      │
│                                             │
│  6. chat.postMessage → link in channel      │
└─────────────────────────────────────────────┘
```

---

## Prerequisites

1. **Slack workspace on a paid plan** (Canvases require this)
2. **Slack CLI** installed: https://api.slack.com/automation/cli/install
3. **Deno** installed: https://deno.land/manual/getting_started/installation
4. **Google Cloud service account** with Sheets API access

---

## Setup

### 1. Clone and configure

```bash
cd deal-notes-app
```

### 2. Update configuration values

There are **three things** you need to update before deploying:

#### a) Spreadsheet ID and sheet name
In `workflows/deal_notes_workflow.ts`, replace:
```ts
spreadsheet_id: "YOUR_SPREADSHEET_ID_HERE",
sheet_name: "Top Deals - Leader Inputs Needed",
```
The spreadsheet ID is the long string in your Google Sheet URL:
`https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit`

#### b) Channel ID (for scheduled trigger)
In `triggers/scheduled_trigger.ts`, replace:
```ts
channel_id: { value: "YOUR_CHANNEL_ID_HERE" },
```
Right-click a channel in Slack → "View channel details" → copy the Channel ID.

#### c) Column indices
In `functions/generate_deal_notes.ts`, verify the `COL` map matches your sheet:
```ts
const COL = {
  RANK: 1,           // B
  ACCOUNT_NAME: 2,   // C
  TOP_DEALS: 3,      // D
  CLOSE_DATE: 4,     // E
  CONCAT: 13,        // N
  LAST_UPDATED: 14,  // O
  OPPORTUNITY: 15,   // P
  PRODUCTS: 16,      // Q
  RECENT_PROGRESS: 17, // R
  NEXT_STEPS: 18,    // S
  FORECASTED_TCV: -1, // Set to actual column index if present
  SLACK_CHANNEL: -1,
  RISK_CONFIDENCE: -1,
  SCI_REQUEST: -1,
};
```
Column A = index 0, B = 1, C = 2, etc. Set any column to `-1` if it doesn't
exist in the sheet (the field will render blank in the canvas for leaders to fill).

### 3. Create Google OAuth2 credentials

Since your org blocks service account keys, we use Slack's built-in OAuth2
system instead. You sign in with your Google account and Slack handles
token storage and refresh.

1. Go to https://console.cloud.google.com → **APIs & Services → Credentials**
2. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**
3. If prompted, configure the OAuth consent screen first:
   - User type: **Internal** (if using Google Workspace) or External
   - App name: "Slack Deal Notes"
   - Add scope: `https://www.googleapis.com/auth/spreadsheets.readonly`
4. Back in Credentials, create the OAuth client ID:
   - Application type: **Web application**
   - Name: "Slack Deal Notes"
   - Authorized redirect URIs: **`https://oauth2.slack.com/external/auth/callback`**
5. Copy the **Client ID** and **Client Secret**
6. Paste the **Client ID** into `external_auth/google_provider.ts` replacing
   `YOUR_GOOGLE_CLIENT_ID_HERE.apps.googleusercontent.com`

### 4. Deploy to Slack

```bash
# Login to Slack CLI
slack login

# Deploy the app
slack deploy

# Add the Google OAuth2 client secret
slack external-auth add-secret

# When prompted:
#   - Select provider: google
#   - Paste your Client Secret

# Connect your Google account
slack external-auth add

# When prompted:
#   - Select provider: google
#   - A browser window opens → sign in with the Google account
#     that has access to the spreadsheet
#   - You'll see "Account successfully connected"

# Verify it worked
slack external-auth add
# You should see "Token Exists? Yes"

# Create the scheduled trigger
slack trigger create --trigger-def triggers/scheduled_trigger.ts

# Create the link trigger (for on-demand runs)
slack trigger create --trigger-def triggers/link_trigger.ts
```

The link trigger will output a URL — paste it into your channel bookmarks
bar or pin it as a message for easy access.

**Note on triggers and auth:**
- **Link trigger** uses `END_USER` auth — the person who clicks it will be
  prompted to connect their Google account (one-time setup).
- **Scheduled trigger** uses `DEVELOPER` auth — it uses the Google account
  you connected via `slack external-auth add` above.

### 5. Test it

Use the link trigger to run a test. Click it in any channel and the app will:
1. Read your Google Sheet
2. Create a new Canvas with all deal cards
3. Post the Canvas link in the channel

---

## Column Mapping Reference

| Canvas Field            | Source                        | Notes                                    |
|-------------------------|-------------------------------|------------------------------------------|
| Account Name (header)   | Column C                      | Direct from sheet                        |
| Opportunity             | Column P                      | Direct from sheet                        |
| Close Date              | Parsed from Concat (col N)    | Falls back to Column E if not in Concat  |
| Account Team            | Parsed from Concat (col N)    | Direct, Direct+1, Direct+2, Direct+3     |
| On-Dash OP / IN / UP+/- | Parsed from Concat (col N)   | Financial breakdown                      |
| Data Cloud              | Parsed from Concat (col N)    | Financial value                          |
| Products                | Column Q                      | Direct from sheet                        |
| Recent Progress         | Column R                      | Direct from sheet                        |
| Next Steps              | Column S                      | Direct from sheet                        |
| Forecasted TCV          | Set COL index or blank        | Leader fills in Canvas                   |
| Slack Channel           | Set COL index or blank        | Leader fills in Canvas                   |
| Risk/Confidence Level   | Set COL index or blank        | Leader fills in Canvas                   |
| SCI Request             | Set COL index or blank        | Leader fills in Canvas                   |
| Account Team Update     | Always blank                  | Leader fills in Canvas                   |

## Deal Grouping

Section headers (like "Q1 Combo (AMER/Global)") are auto-detected by checking
for rows where Column A has text but the main data columns (Rank, Account Name,
Concat, Opportunity) are empty. Each section becomes a separate group in the
Canvas TOC and deal card layout.

---

## Canvas Output Structure

```
# TMT Deal Notes | Week of March 19, 2026
---

## Q1 Combo (AMER/Global)
1. Sunshine Software Holdings, Inc.
2. SONY GROUP CORPORATION
3. Paypal, Inc.
...

## February Deals
1. Account X
2. Account Y
...

---

# Q1 Combo (AMER/Global)

## Sunshine Software Holdings, Inc.

**Opportunity:** Full Stack consolidation on Salesforce.
**Close Date:** 04/30/2026
**Account Team:** Direct: Lenore Lang, Direct+1: Tony Kays, Direct+2: Genna Gwynn
**On-Dash OP:** $5.5M | **IN:** $2.0M | **UP+:** $3.5M | **UP-:** $0.0M | **DC:** $0.0M

**Forecasted TCV:**
**Products:** Velocity AELA
**Slack Channel:**
**Risk/Confidence Level:**
**SCI Request:**

**Account Team Update:**

**Recent Progress:**
SIC planning on track. Nathalie confirmed to attend...

**Next Steps:**
- Daily walk thru's on the calendar with KT and TK
- customer agenda validation call happening today
...

---

## SONY GROUP CORPORATION
...
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Missing GOOGLE_SERVICE_ACCOUNT_JSON" | Run `slack env add GOOGLE_SERVICE_ACCOUNT_JSON` and paste the full JSON |
| "No data returned from sheet" | Check the sheet name matches exactly (case-sensitive) |
| "canvas_creation_failed" | Verify your workspace is on a paid plan |
| Canvas is empty or missing deals | Check `COL` indices match your actual sheet columns |
| Concat parsing is off | Check that the pipe `\|` separator and field labels match your Concat formula |
| Deals not grouped correctly | Verify section header rows have text in Col A but empty data columns |
