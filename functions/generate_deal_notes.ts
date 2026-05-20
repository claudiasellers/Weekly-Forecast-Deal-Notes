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
      google_access_token_id: {
        type: Schema.slack.types.oauth2,
        oauth2_provider_key: "google",
        description: "Google OAuth2 token for Sheets access",
      },
    },
    required: ["channel_id", "spreadsheet_id", "sheet_name", "google_access_token_id"],
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

  // Format (pipe-delimited):
  //   "<Account>, Account Team: Name1 | Name2 | Name3 | Name4 | On-Dash OP: $X
  //    | IN: $X | UP+: $X | UP- : $X | Data Cloud OP: $X, Close Date: MM/DD/YYYY"

  // Two supported team formats:
  //   (A) "Account Team: Name1 | Name2 | Name3 | Name4 | On-Dash OP: ..."
  //   (B) "Direct: Name, Direct+1: Name, Direct+2: Name | On-Dash OP: ..."
  let accountTeam = "";

  const teamMatch = concat.match(
    /Account Team\s*:\s*([\s\S]*?)(?=\s*\|\s*(?:On-Dash OP|IN|UP\+|UP-|Data Cloud)\b|,\s*Close Date\b|$)/i,
  );
  if (teamMatch) {
    accountTeam = teamMatch[1]
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(", ");
  } else {
    // Fallback: old "Direct: …, Direct+1: …, Direct+2: …" format.
    // Team entries live before the first pipe; financials live after.
    const teamPart = concat.split("|")[0] ?? "";
    const teamEntries: string[] = [];
    const teamRegex = /(Direct(?:\+\d)?)\s*:\s*([^,|]+)/gi;
    let m;
    while ((m = teamRegex.exec(teamPart)) !== null) {
      teamEntries.push(`${m[1].trim()}: ${m[2].trim()}`);
    }
    accountTeam = teamEntries.join(", ");
  }

  // Extract financial values from the full concat string.
  const extract = (label: string, text: string): string => {
    const escaped = label.replace(/[+\-]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s*:\\s*(\\$[\\d.,]+[MmKkBb]?)`, "i");
    const m = text.match(re);
    return m ? m[1] : "$0.0M";
  };

  const closeDateMatch = concat.match(/Close\s*Date\s*:\s*([\d/\-]+)/i);

  return {
    accountTeam,
    onDashOP: extract("On-Dash OP", concat),
    inValue: extract("IN", concat),
    upPlus: extract("UP\\+", concat),
    upMinus: extract("UP-", concat),
    // Match either "Data Cloud OP" or "Data Cloud"
    dataCloud: extract("Data Cloud(?: OP)?", concat),
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
  CLOSE_DATE: 4,     // E — or pulled from Concat
  CONCAT: 13,        // N
  LAST_UPDATED: 14,  // O — adjust based on actual position
  OPPORTUNITY: 15,   // P
  PRODUCTS: 16,      // Q
  RECENT_PROGRESS: 17, // R
  NEXT_STEPS: 18,    // S
  // Add more as needed for columns to the right:
  RISK_CONFIDENCE: 19,   // T
  FORECASTED_TCV: 20,    // U
  SCI_REQUEST: 21,       // V
  SLACK_CHANNEL: 22,     // W
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
// Markdown sanitization
// ---------------------------------------------------------------------------
/**
 * Sanitize free-text from the sheet before embedding in Canvas markdown.
 * Slack Canvas rejects the whole document with "Unsupported input" if a
 * stray `|` appears outside a table context, so we escape it. We also strip
 * zero-width characters and control chars that can sneak in via copy-paste.
 */
function sanitizeForMarkdown(value: string): string {
  if (!value) return "";
  return value
    // Remove zero-width and most non-printable control chars (keep \n, \t)
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F​-‍﻿]/g, "")
    // Replace pipes — Slack Canvas's parser treats `|` as a table delimiter
    // and rejects the whole document if it appears outside a table context.
    // Backslash-escape is not honored, so substitute a visually similar char.
    .replace(/\|/g, "/");
}

// ---------------------------------------------------------------------------
// Link helpers
// ---------------------------------------------------------------------------
const URL_REGEX = /https?:\/\/[^\s)]+/gi;

/**
 * Format a Slack Channel cell that may contain a channel name and/or a URL
 * (possibly on separate lines) into a markdown hyperlink.
 */
function formatSlackChannelCell(value: string): string {
  if (!value) return "";
  const urlMatch = value.match(URL_REGEX);
  if (!urlMatch) return sanitizeForMarkdown(value);
  const url = urlMatch[0];
  // Remove the URL from the cell to find any label text (e.g. channel name)
  const rawLabel = value.replace(url, "").replace(/\s+/g, " ").trim();
  const label = sanitizeForMarkdown(rawLabel).replace(/[\[\]]/g, "");
  if (label) return `[${label}](${url})`;
  // Fall back to #channelID derived from the archive URL
  const channelId = url.match(/\/archives\/([A-Z0-9]+)/i)?.[1];
  return channelId ? `[#${channelId}](${url})` : `[${url}](${url})`;
}

/**
 * Format a cell that may contain free text AND one or more URLs into a safe
 * markdown string. Bare URLs in Canvas markdown can trip the parser (especially
 * Slack archive URLs with `&` query params), so each URL is collapsed into a
 * proper `[label](url)` markdown link. All remaining text is kept inline and
 * sanitized.
 */
function formatCellWithLinks(value: string): string {
  if (!value) return "";
  // Collapse internal whitespace (preserve paragraph breaks as single spaces
  // for the label-adjacent inline format used in deal cards).
  const compact = value.replace(/\s+/g, " ").trim();
  const urls = compact.match(URL_REGEX);
  if (!urls || urls.length === 0) return sanitizeForMarkdown(compact);
  let remaining = compact;
  let linkSuffix = "";
  for (const url of urls) {
    remaining = remaining.replace(url, "").replace(/\s+/g, " ").trim();
    const channelId = url.match(/\/archives\/([A-Z0-9]+)/i)?.[1];
    const label = channelId ? `#${channelId}` : "link";
    linkSuffix += ` [${label}](${url})`;
  }
  const cleaned = sanitizeForMarkdown(remaining).replace(/[\[\]]/g, "");
  return cleaned ? `${cleaned}${linkSuffix}` : linkSuffix.trim();
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
  lines.push(`# TMT Deal Notes — Week of ${weekDate}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ---- DEAL CARDS ----
  for (const section of sections) {
    lines.push(`# ${section.sectionName}`);
    lines.push("");

    for (const deal of section.deals) {
      lines.push(`## :deal-937: ${sanitizeForMarkdown(deal.accountName)}`);
      lines.push("");
      lines.push("---");
      lines.push("");

      lines.push(`**Opportunity:** ${sanitizeForMarkdown(deal.opportunity || "")}`);
      lines.push("");
      lines.push(`**Close Date:** ${sanitizeForMarkdown(deal.closeDate || "")}`);
      lines.push("");
      lines.push(`**Account Team:** ${sanitizeForMarkdown(deal.accountTeam || "")}`);
      lines.push("");
      lines.push(
        `**On-Dash OP:** ${deal.onDashOP} · **IN:** ${deal.inValue} · **UP+:** ${deal.upPlus} · **UP-:** ${deal.upMinus} · **DC:** ${deal.dataCloud}`,
      );
      lines.push("");
      lines.push(`**Forecasted TCV:** ${sanitizeForMarkdown(deal.forecastedTCV || "")}`);
      lines.push("");
      lines.push(`**Products:** ${sanitizeForMarkdown(deal.products || "")}`);
      lines.push("");
      lines.push(`**Slack Channel:** ${formatSlackChannelCell(deal.slackChannel)}`);
      lines.push("");
      lines.push(`**Risk/Confidence Level:** ${sanitizeForMarkdown(deal.riskConfidence || "")}`);
      lines.push("");
      lines.push(`**SCI Request:** ${formatCellWithLinks(deal.sciRequest || "")}`);
      lines.push("");
      lines.push("---");
      lines.push("");

      lines.push(`**Account Team Update:** ${sanitizeForMarkdown(deal.lastUpdated || "")}`);
      lines.push("");

      if (deal.recentProgress) {
        lines.push(`**Recent Progress:** ${sanitizeForMarkdown(deal.recentProgress)}`);
      } else {
        lines.push("**Recent Progress:**");
      }
      lines.push("");

      if (deal.nextSteps) {
        lines.push("**Next Steps:**");
        lines.push("");
        lines.push(sanitizeForMarkdown(deal.nextSteps));
      } else {
        lines.push("**Next Steps:**");
      }
      lines.push("");
      lines.push("*Press Cmd + ↑ / Ctrl + Home to return to top*");
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Canvas API access control
// ---------------------------------------------------------------------------
// Required by Slack App approval: every canvas read/write API call is routed
// through this wrapper, which extracts the canvas_id from the request params
// and validates it against the authorized ID returned by canvases.create.
// If the canvas_id is missing or does not match, the call is rejected before
// it reaches the Slack API.
// ---------------------------------------------------------------------------
// deno-lint-ignore require-await
async function canvasApiCall(
  // deno-lint-ignore no-explicit-any
  client: { apiCall: (method: string, params: Record<string, unknown>) => Promise<any> },
  method: string,
  authorizedCanvasId: string,
  params: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const targetCanvasId = params.canvas_id;
  if (!targetCanvasId) {
    throw new Error(
      `Canvas access denied [${method}]: canvas_id parameter is missing.`,
    );
  }
  if (typeof targetCanvasId !== "string") {
    throw new Error(
      `Canvas access denied [${method}]: canvas_id is not a string.`,
    );
  }
  if (targetCanvasId !== authorizedCanvasId) {
    throw new Error(
      `Canvas access denied [${method}]: ` +
      `canvas_id "${targetCanvasId}" does not match the authorized Canvas ` +
      `"${authorizedCanvasId}" created in this execution. ` +
      `Rejecting operation to prevent unintended Canvas access.`,
    );
  }
  return client.apiCall(method, params);
}

// ---------------------------------------------------------------------------
// Slack function handler
// ---------------------------------------------------------------------------
export default SlackFunction(
  GenerateDealNotesFunction,
  async ({ inputs, client }) => {
    try {
      // 1. Get Google access token via Slack's external auth system
      const auth = await client.apps.auth.external.get({
        external_token_id: inputs.google_access_token_id,
      });

      if (!auth.ok) {
        return {
          error: `Failed to get Google auth token: ${auth.error}. ` +
            `Make sure you've completed the OAuth2 setup: slack external-auth add`,
        };
      }

      const accessToken = auth.external_token as string;

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

      // TEMP DIAGNOSTIC: scan every deal field for chars that commonly trip
      // Slack's canvas markdown parser ("Unsupported input").
      {
        const suspiciousPatterns: [string, RegExp][] = [
          // deno-lint-ignore no-control-regex
          ["control char", /[\x00-\x08\x0B\x0C\x0E-\x1F]/],
          ["zero-width", /[​-‍﻿]/],
          ["html-like tag", /<\/?[a-zA-Z][^>]*>/],
          ["backtick", /`/],
          ["unbalanced paren", /\([^)]*$|^[^(]*\)/],
          ["unbalanced bracket", /\[[^\]]*$|^[^\[]*\]/],
          ["pipe char", /\|/],
          ["stray lone backslash", /\\[^\\nrt"'`]/],
        ];
        let dealIdx = 0;
        for (const section of sections) {
          for (const deal of section.deals) {
            const fields: [string, string][] = [
              ["accountName", deal.accountName],
              ["opportunity", deal.opportunity],
              ["products", deal.products],
              ["recentProgress", deal.recentProgress],
              ["nextSteps", deal.nextSteps],
              ["slackChannel", deal.slackChannel],
              ["riskConfidence", deal.riskConfidence],
              ["sciRequest", deal.sciRequest],
              ["accountTeam", deal.accountTeam],
              ["lastUpdated", deal.lastUpdated],
            ];
            for (const [fieldName, value] of fields) {
              if (!value) continue;
              for (const [label, re] of suspiciousPatterns) {
                const m = value.match(re);
                if (m) {
                  console.log(
                    `[scan] deal#${dealIdx} "${deal.accountName}" field=${fieldName} issue=${label} snippet=${JSON.stringify(value.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + 40))}`,
                  );
                }
              }
            }
            dealIdx++;
          }
        }
      }

      const now = new Date();
      const weekDate = now.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const canvasTitle = `TMT Deal Notes | Week of ${weekDate}`;

      // 4. Get workspace info (needed for URLs)
      const teamInfo = await client.apiCall("auth.test", {});
      const workspaceUrl = (teamInfo.url as string || "").replace(/\/$/, "");
      // In Enterprise Grid, team_id may return the org ID (E-prefix).
      // We need the workspace team ID (T-prefix) for canvas URLs.
      // Try team_id first, fall back to checking the URL for the team.
      const teamId = (teamInfo.team_id as string || "").startsWith("T")
        ? teamInfo.team_id as string
        : "T06GXKG9745"; // workspace team ID
      console.log("auth.test team_id:", teamInfo.team_id, "enterprise_id:", teamInfo.enterprise_id, "using:", teamId);

      // 5. Create canvas with H3 "Back to Top" markers (no links yet)
      // TEMP DIAGNOSTIC: try creating a trivial canvas first to isolate
      // whether canvases.create works AT ALL for this app in this workspace.
      const probe = await client.apiCall("canvases.create", {
        title: `Probe canvas ${Date.now()}`,
        document_content: { type: "markdown", markdown: "# Probe\n\nHello world." },
      });
      console.log("probe canvases.create response:", JSON.stringify(probe));

      const initialMarkdown = buildCanvasMarkdown(sections, weekDate);
      console.log("canvas markdown length:", initialMarkdown.length, "totalDeals:", totalDeals);
      // Log first 400 and last 400 chars of what we're sending to Slack
      console.log("markdown head:", JSON.stringify(initialMarkdown.slice(0, 400)));
      console.log("markdown tail:", JSON.stringify(initialMarkdown.slice(-400)));
      // Log count of pipes to verify sanitizer ran
      const pipeCount = (initialMarkdown.match(/\|/g) || []).length;
      console.log("pipe count in final markdown:", pipeCount);
      const canvasRes = await client.apiCall("canvases.create", {
        title: canvasTitle,
        document_content: { type: "markdown", markdown: initialMarkdown },
      });

      if (!canvasRes.ok) {
        console.log("canvases.create full response:", JSON.stringify(canvasRes));
        const extra = (canvasRes.response_metadata as { messages?: string[] } | undefined)?.messages;
        return {
          error: `Failed to create canvas: ${canvasRes.error}` +
            (extra ? ` | messages: ${extra.join(" ; ")}` : ""),
        };
      }

      const canvasId = canvasRes.canvas_id as string;
      // Sealed single source of truth for the Canvas created in this execution.
      // Captured exactly once from the canvases.create response, never
      // reassigned, and not reachable from any external input. This is the
      // value that every subsequent canvases:read / canvases:write call is
      // checked against inside canvasApiCall — the wrapper compares the
      // canvas_id on the outgoing request payload to AUTHORIZED_CANVAS_ID and
      // rejects the call if they differ.
      const AUTHORIZED_CANVAS_ID: string = canvasId;
      const canvasUrl = `${workspaceUrl}/docs/${teamId}/${canvasId}`;

      // 6. Look up H2 (deal names) for TOC jump links
      const h2Lookup = await canvasApiCall(
        client, "canvases.sections.lookup", AUTHORIZED_CANVAS_ID,
        { canvas_id: canvasId, criteria: { section_types: ["h2"] } },
      );
      const allH2s = (h2Lookup.sections || []) as { id: string }[];
      console.log("H2s:", allH2s.length);

      // 7. Insert TOC at start
      try {
        if (allH2s.length === totalDeals) {
          const tocLines: string[] = [];
          let dealIdx = 0;
          for (const section of sections) {
            tocLines.push(`### ${section.sectionName}`);
            tocLines.push("");
            for (let i = 0; i < section.deals.length; i++) {
              const deal = section.deals[i];
              const sectionId = allH2s[dealIdx]?.id;
              if (sectionId) {
                tocLines.push(`${i + 1}. [**${deal.accountName}**](${canvasUrl}?focus_section_id=${encodeURIComponent(sectionId)})`);
              } else {
                tocLines.push(`${i + 1}. **${deal.accountName}**`);
              }
              dealIdx++;
            }
            tocLines.push("");
          }
          tocLines.push("---");
          tocLines.push("");

          const tocRes = await canvasApiCall(
            client, "canvases.edit", AUTHORIZED_CANVAS_ID,
            {
              canvas_id: canvasId,
              changes: [{
                operation: "insert_at_start",
                document_content: { type: "markdown", markdown: tocLines.join("\n") },
              }],
            },
          );
          console.log("TOC insert ok:", tocRes.ok, "error:", tocRes.error);
        }
      } catch (linkErr) {
        console.log("Jump link setup failed (non-fatal):", linkErr);
      }

      // 8. Set canvas access for the channel
      await canvasApiCall(
        client, "canvases.access.set", AUTHORIZED_CANVAS_ID,
        {
          canvas_id: canvasId,
          access_level: "write",
          channel_ids: [inputs.channel_id],
        },
      );

      // 9. Post the canvas link to the channel
      const sectionSummary = sections
        .map((s) => `${s.sectionName}: ${s.deals.length} deals`)
        .join(" · ");

      await client.apiCall("chat.postMessage", {
        channel: inputs.channel_id,
        text: `:clipboard: *${canvasTitle}*\n\n${sectionSummary} · ${totalDeals} total deals\n\nCanvas is ready for leader input — please update your deal notes by EOD Thursday.\n\n<${canvasUrl}|Open Canvas>`,
      });

      return { outputs: { canvas_id: canvasId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Deal notes generation failed: ${message}` };
    }
  },
);
