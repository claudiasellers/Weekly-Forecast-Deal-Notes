import { DefineWorkflow, Schema } from "deno-slack-sdk/mod.ts";
import { GenerateDealNotesFunction } from "../functions/generate_deal_notes.ts";

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------
export const DealNotesWorkflow = DefineWorkflow({
  callback_id: "deal_notes_workflow",
  title: "Generate TMT Deal Notes Canvas",
  description:
    "Pulls deal data from the Google Sheet and creates a new Slack Canvas with formatted deal cards, then posts the link to a channel.",
  input_parameters: {
    properties: {
      channel_id: {
        type: Schema.slack.types.channel_id,
        description: "Channel to post the canvas link in",
      },
      google_access_token_id: {
        type: Schema.slack.types.oauth2,
        oauth2_provider_key: "google",
        description: "Google OAuth2 token",
      },
    },
    required: ["channel_id", "google_access_token_id"],
  },
});

// ---------------------------------------------------------------------------
// Step 1: Run the custom function
// ---------------------------------------------------------------------------
DealNotesWorkflow.addStep(GenerateDealNotesFunction, {
  channel_id: DealNotesWorkflow.inputs.channel_id,
  google_access_token_id: DealNotesWorkflow.inputs.google_access_token_id,

  // ┌──────────────────────────────────────────────────────────────────────┐
  // │  UPDATE THESE TWO VALUES                                            │
  // │                                                                     │
  // │  spreadsheet_id  → the long ID from your Google Sheet URL           │
  // │                     https://docs.google.com/spreadsheets/d/THIS_PART│
  // │                                                                     │
  // │  sheet_name      → the exact tab name where deal data lives         │
  // └──────────────────────────────────────────────────────────────────────┘
  spreadsheet_id: "1RxghHl6maeyY38UieOPzJxuxhluGTBSes3k9Ye1JiHg",
  sheet_name: "Top Deals - Leader Inputs Needed",
});
