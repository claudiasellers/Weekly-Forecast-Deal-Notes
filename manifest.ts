import { Manifest } from "deno-slack-sdk/mod.ts";
import { DealNotesWorkflow } from "./workflows/deal_notes_workflow.ts";
import GoogleProvider from "./external_auth/google_provider.ts";

export default Manifest({
  name: "Weekly Forecast Deal Notes",
  description:
    "Reads deal data from Google Sheets and creates a formatted Slack Canvas with deal cards for sales leader review.",
  icon: "assets/icon.png",
  workflows: [DealNotesWorkflow],
  externalAuthProviders: [GoogleProvider],
  outgoingDomains: [
    "sheets.googleapis.com",
    "www.googleapis.com",
  ],
  features: {
    appHome: {
      messagesTabEnabled: true,
      messagesTabReadOnlyEnabled: false,
    },
  },
  botScopes: [
    "commands",
    "chat:write",
    "chat:write.public",
    "canvases:write",
  ],
});
