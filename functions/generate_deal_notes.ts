import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";

// ---------------------------------------------------------------------------
// Function definition
// ---------------------------------------------------------------------------
export const GenerateDealNotesFunction = DefineFunction({
  callback_id: "generate_deal_notes",
  title: "Generate Deal Notes Canvas",
  description:
    "Reads deal data from the Google Sheet, builds formatted markdown, creates a Slack Canvas, and posts the link to a channel.",
  source_file: "functions/generate_deal_notes.ts",
  input_parameters: {
    properties: {
      channel_id: {
        type: Schema.slack.types.channel_id,
        description: "Channel to post the canvas link in",
      },
      spreadsheet_id: {
        type: Schema.types.string,
        description: "Google Sheets spreadsheet ID",
      },
      sheet_name: {
        type: Schema.types.string,
        description: "Tab/sheet name to read from (e.g. 'Top Deals - Leader Inputs Needed')",
      },
    },
    required: ["channel_id", "spreadsheet_id", "sheet_name"],
  },
  output_parameters: {
    properties: {
      canvas_id: {
        type: Schema.types.string,
        description: "ID of the created canvas",
      },
    },
    required: ["canvas_id"],
  },
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DealRow {
  rank: string;
  accountName: string;
  topDeals: string;
  closeDate: string;
  concat: string;
  lastUpdated: string;
  opportunity: string;
  products: string;
  recentProgress: string;
  nextSteps: string;
  // Parsed from concat or additional columns
  accountTeam: string;
  onDashOP: string;
  inValue: string;
  upPlus: string;
  upMinus: string;
  dataCloud: string;
  forecastedTCV: string;
  slackChannel: string;
  riskConfidence: string;
  sciRequest: string;
}

interface DealSection {
  sectionName: string;
  deals: DealRow[];
}

// ---------------------------------------------------------------------------
// Google Sheets helpers
// ---------------------------------------------------------------------------
async function getAccessToken(serviceAccountJSON: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJSON);

  // Build JWT header + claim set
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(
      /=+$/,
      "",
    );

  const headerB64 = encode(header);
  const claimB64 = encode(claimSet);
  const unsignedToken = `${headerB64}.${claimB64}`;

  // Import the private key and sign
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const jwt = `${unsignedToken}.${sigB64}`;

  // Exchange JWT for access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(
      `Failed to get access token: ${JSON.stringify(tokenData)}`,
    );
  }
  return tokenData.access_token;
}

async function fetchSheetData(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
): Promise<string[][]> {
  const range = encodeURIComponent(`${sheetName}`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  if (!data.values) {
    throw new Error(
      `No data returned from sheet "${sheetName}": ${JSON.stringify(data)}`,
    );
  }
  return data.values;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the Concat column value into structured team + financial fields.
 *
 * Expected format (example):
 *   "Sunshine Software Holdings, Inc., Direct: Lenore Lang, Direct+1: Tony Kays,
 *    Direct+2: Genna Gwynn | On-Dash OP: $5.5M, IN: $2.0M, UP+: $3.5M,
 *    UP-: $0.0M, Data Cloud: $0.0M, Close Date: 04/30/2026"
 */
function parseConcat(concat: string): {
  accountTeam: string;
  onDashOP: string;
  inValue: string;
  upPlus: string;
  upMinus: string;
  dataCloud: string;
  closeDate: string;
} {
  const defaults = {
    accountTeam: "",
    onDashOP: "$0.0M",
    inValue: "$0.0M",
    upPlus: "$0.0M",
    upMinus: "$0.0M",
    dataCloud: "$0.0M",
    closeDate: "",
  };

  if (!concat) return defaults;

  // Split on pipe — left side is team, right side is financials
  const pipeParts = concat.split("|");
  const teamPart = pipeParts[0]?.trim() ?? "";
  const financialPart = pipeParts.slice(1).join("|").trim();

  // Extract team names from the team part
  // Pattern: "Direct: Name, Direct+1: Name, Direct+2: Name"
  const teamEntries: string[] = [];
  const teamRegex = /(Direct(?:\+\d)?)\s*:\s*([^,|]+)/gi;
  let match;
  while ((match = teamRegex.exec(teamPart)) !== null) {
    teamEntries.push(`${match[1].trim()}: ${match[2].trim()}`);
  }
  const accountTeam = teamEntries.join(", ");

  // Extract financial values
  const extract = (label: string, text: string): string => {
    const escaped = label.replace(/[+\-]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s*:\\s*(\\$[\\d.,]+[MmKkBb]?)`, "i");
    const m = text.match(re);
    return m ? m[1] : "$0.0M";
  };

  const closeDateMatch = financialPart.match(
    /Close\s*Date\s*:\s*([\d/\-]+)/i,
  );

  return {
    accountTeam,
    onDashOP: extract("On-Dash OP", financialPart),
    inValue: extract("IN", financialPart),
    upPlus: extract("UP\\+", financialPart),
    upMinus: extract("UP-", financialPart),
    dataCloud: extract("Data Cloud", financialPart),
    closeDate: closeDateMatch ? closeDateMatch[1] : "",
  };
}

/**
 * Detect section header rows and group deals into sections.
 *
 * A section header row is identified by:
 *   - Column A (index 0) containing text like "Q1 Combo", "February", "March", etc.
 *   - Most other columns being empty
 *
 * Adjust column indices below to match your actual sheet layout.
 */

// ---- COLUMN INDEX MAP ----
// Update these if your sheet columns shift.
const COL = {
  RANK: 1,           // B
  ACCOUNT_NAME: 2,   // C
  TOP_DEALS: 3,      // D (may not exist — adjust as needed)
  CLOSE_DATE: 4,     // E — or pulled from Concat
  CONCAT: 13,        // N
  LAST_UPDATED: 14,  // O — adjust based on actual position
  OPPORTUNITY: 15,   // P
  PRODUCTS: 16,      // Q
  RECENT_PROGRESS: 17, // R
  NEXT_STEPS: 18,    // S
  // Add more as needed for columns to the right:
  FORECASTED_TCV: -1,    // set to actual index if present, -1 = not in sheet
  SLACK_CHANNEL: -1,
  RISK_CONFIDENCE: -1,
  SCI_REQUEST: -1,
};

function isSectionHeaderRow(row: string[]): boolean {
  // Section headers typically have text in column A and most other cells empty
  const cellA = (row[0] ?? "").trim();
  if (!cellA) return false;

  // Count how many of the main data columns are empty
  const dataCols = [COL.RANK, COL.ACCOUNT_NAME, COL.CONCAT, COL.OPPORTUNITY];
  const emptyCount = dataCols.filter((i) => !(row[i] ?? "").trim()).length;

  // If most data columns are empty and A has text, it's likely a section header
  return emptyCount >= 3;
}

function isHeaderRow(row: string[]): boolean {
  const joined = row.join(" ").toLowerCase();
  return joined.includes("rank") && joined.includes("close date");
}

function isDealRow(row: string[]): boolean {
  const rank = (row[COL.RANK] ?? "").trim();
  const name = (row[COL.ACCOUNT_NAME] ?? "").trim();
  return rank !== "" && name !== "" && /^\d+$/.test(rank);
}

function parseRows(rows: string[][]): DealSection[] {
  const sections: DealSection[] = [];
  let currentSection: DealSection = { sectionName: "Deals", deals: [] };

  for (const row of rows) {
    // Skip the column-header row
    if (isHeaderRow(row)) continue;

    // Check for section headers
    if (isSectionHeaderRow(row)) {
      // Save previous section if it has deals
      if (currentSection.deals.length > 0) {
        sections.push(currentSection);
      }
      currentSection = {
        sectionName: (row[0] ?? "Deals").trim(),
        deals: [],
      };
      continue;
    }

    // Parse deal rows
    if (isDealRow(row)) {
      const cell = (i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
      const parsed = parseConcat(cell(COL.CONCAT));

      const deal: DealRow = {
        rank: cell(COL.RANK),
        accountName: cell(COL.ACCOUNT_NAME),
        topDeals: cell(COL.TOP_DEALS),
        closeDate: parsed.closeDate || cell(COL.CLOSE_DATE),
        concat: cell(COL.CONCAT),
        lastUpdated: cell(COL.LAST_UPDATED),
        opportunity: cell(COL.OPPORTUNITY),
        products: cell(COL.PRODUCTS),
        recentProgress: cell(COL.RECENT_PROGRESS),
        nextSteps: cell(COL.NEXT_STEPS),
        accountTeam: parsed.accountTeam,
        onDashOP: parsed.onDashOP,
        inValue: parsed.inValue,
        upPlus: parsed.upPlus,
        upMinus: parsed.upMinus,
        dataCloud: parsed.dataCloud,
        forecastedTCV: cell(COL.FORECASTED_TCV),
        slackChannel: cell(COL.SLACK_CHANNEL),
        riskConfidence: cell(COL.RISK_CONFIDENCE),
        sciRequest: cell(COL.SCI_REQUEST),
      };

      currentSection.deals.push(deal);
    }
  }

  // Push final section
  if (currentSection.deals.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------
function buildCanvasMarkdown(
  sections: DealSection[],
  weekDate: string,
): string {
  const lines: string[] = [];

  // Title
  lines.push(`# TMT Deal Notes | Week of ${weekDate}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ---- TABLE OF CONTENTS ----
  for (const section of sections) {
    lines.push(`## ${section.sectionName}`);
    lines.push("");
    for (let i = 0; i < section.deals.length; i++) {
      const deal = section.deals[i];
      lines.push(`${i + 1}. **${deal.accountName}**`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  // ---- DEAL CARDS ----
  for (const section of sections) {
    lines.push(`# ${section.sectionName}`);
    lines.push("");

    for (const deal of section.deals) {
      // Account header
      lines.push(`## ${deal.accountName}`);
      lines.push("");

      // Pre-populated fields
      if (deal.opportunity) {
        lines.push(`**Opportunity:** ${deal.opportunity}`);
      } else {
        lines.push(`**Opportunity:**`);
      }

      if (deal.closeDate) {
        lines.push(`**Close Date:** ${deal.closeDate}`);
      } else {
        lines.push(`**Close Date:**`);
      }

      if (deal.accountTeam) {
        lines.push(`**Account Team:** ${deal.accountTeam}`);
      } else {
        lines.push(`**Account Team:**`);
      }

      // Financial summary line
      lines.push(
        `**On-Dash OP:** ${deal.onDashOP} | **IN:** ${deal.inValue} | **UP+:** ${deal.upPlus} | **UP-:** ${deal.upMinus} | **DC:** ${deal.dataCloud}`,
      );

      lines.push("");

      // Fields that may be pre-populated or blank for leaders
      if (deal.forecastedTCV) {
        lines.push(`**Forecasted TCV:** ${deal.forecastedTCV}`);
      } else {
        lines.push(`**Forecasted TCV:**`);
      }

      if (deal.products) {
        lines.push(`**Products:** ${deal.products}`);
      } else {
        lines.push(`**Products:**`);
      }

      if (deal.slackChannel) {
        lines.push(`**Slack Channel:** ${deal.slackChannel}`);
      } else {
        lines.push(`**Slack Channel:**`);
      }

      if (deal.riskConfidence) {
        lines.push(`**Risk/Confidence Level:** ${deal.riskConfidence}`);
      } else {
        lines.push(`**Risk/Confidence Level:**`);
      }

      if (deal.sciRequest) {
        lines.push(`**SCI Request:** ${deal.sciRequest}`);
      } else {
        lines.push(`**SCI Request:**`);
      }

      lines.push("");

      // Account Team Update / Recent Progress / Next Steps
      lines.push("**Account Team Update:**");
      lines.push("");

      if (deal.recentProgress) {
        lines.push("**Recent Progress:**");
        lines.push(deal.recentProgress);
      } else {
        lines.push("**Recent Progress:**");
      }

      lines.push("");

      if (deal.nextSteps) {
        lines.push("**Next Steps:**");
        lines.push(deal.nextSteps);
      } else {
        lines.push("**Next Steps:**");
      }

      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Slack function handler
// ---------------------------------------------------------------------------
export default SlackFunction(
  GenerateDealNotesFunction,
  async ({ inputs, client, env }) => {
    try {
      // 1. Get Google access token from service account credentials
      const serviceAccountJSON = env.GOOGLE_SERVICE_ACCOUNT_JSON;
      if (!serviceAccountJSON) {
        return {
          error:
            "Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable. Add your service account credentials via `slack env add`.",
        };
      }

      const accessToken = await getAccessToken(serviceAccountJSON);

      // 2. Fetch sheet data
      const rows = await fetchSheetData(
        accessToken,
        inputs.spreadsheet_id,
        inputs.sheet_name,
      );

      if (rows.length < 2) {
        return { error: "Sheet has no data rows." };
      }

      // 3. Parse rows into sections and deals
      const sections = parseRows(rows);

      if (sections.length === 0 || sections.every((s) => s.deals.length === 0)) {
        return { error: "No deal data found in the sheet." };
      }

      const totalDeals = sections.reduce((n, s) => n + s.deals.length, 0);

      // 4. Build the canvas markdown
      const now = new Date();
      const weekDate = now.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const markdown = buildCanvasMarkdown(sections, weekDate);

      // 5. Create the Slack Canvas
      const canvasTitle = `TMT Deal Notes | Week of ${weekDate}`;

      const canvasRes = await client.apiCall("canvases.create", {
        title: canvasTitle,
        document_content: {
          type: "markdown",
          markdown: markdown,
        },
      });

      if (!canvasRes.ok) {
        return {
          error: `Failed to create canvas: ${canvasRes.error}`,
        };
      }

      const canvasId = canvasRes.canvas_id as string;

      // 6. Set canvas access for the channel
      await client.apiCall("canvases.access.set", {
        canvas_id: canvasId,
        access_level: "write",
        channel_ids: [inputs.channel_id],
      });

      // 7. Post the canvas link to the channel
      const sectionSummary = sections
        .map((s) => `${s.sectionName}: ${s.deals.length} deals`)
        .join(" · ");

      await client.apiCall("chat.postMessage", {
        channel: inputs.channel_id,
        text: `:clipboard: *${canvasTitle}*\n\n${sectionSummary} · ${totalDeals} total deals\n\nCanvas is ready for leader input — please update your deal notes by EOD Thursday.`,
        unfurl_links: true,
      });

      // Also share the canvas directly in the channel for unfurling
      await client.apiCall("chat.postMessage", {
        channel: inputs.channel_id,
        text: `https://slack.com/docs/${canvasId}`,
      });

      return { outputs: { canvas_id: canvasId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Deal notes generation failed: ${message}` };
    }
  },
);
