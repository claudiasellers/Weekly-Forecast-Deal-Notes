import { Manifest } from "deno-slack-sdk/mod.ts";
import { DealNotesWorkflow } from "./workflows/deal_notes_workflow.ts";

export default Manifest({
  name: "TMT Deal Notes",
  description:
    "Reads deal data from Google Sheets and creates a formatted Slack Canvas with deal cards for sales leader review.",
  icon: "assets/icon.png",
  workflows: [DealNotesWorkflow],
  outgoingDomains: [
    "sheets.googleapis.com",
    "oauth2.googleapis.com",
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
