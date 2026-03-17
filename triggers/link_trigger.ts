import { Trigger } from "deno-slack-api/types.ts";
import { TriggerContextData, TriggerTypes } from "deno-slack-api/mod.ts";
import { DealNotesWorkflow } from "../workflows/deal_notes_workflow.ts";

/**
 * Link trigger — paste this into a channel or bookmark bar for on-demand runs.
 *
 * When clicked, it prompts the user to select a channel, then runs the
 * workflow to create a fresh canvas and post the link there.
 *
 * To create this trigger after deploying:
 *   slack trigger create --trigger-def triggers/link_trigger.ts
 */
const LinkTrigger: Trigger<typeof DealNotesWorkflow.definition> = {
  type: TriggerTypes.Shortcut,
  name: "Generate Deal Notes Canvas",
  description:
    "Manually create this week's TMT Deal Notes canvas on demand",
  workflow: `#/workflows/${DealNotesWorkflow.definition.callback_id}`,
  inputs: {
    channel_id: {
      value: TriggerContextData.Shortcut.channel_id,
    },
  },
};

export default LinkTrigger;
