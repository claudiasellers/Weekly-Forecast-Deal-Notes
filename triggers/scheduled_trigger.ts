import { Trigger } from "deno-slack-api/types.ts";
import { TriggerContextData, TriggerTypes } from "deno-slack-api/mod.ts";
import { DealNotesWorkflow } from "../workflows/deal_notes_workflow.ts";

/**
 * Scheduled trigger — runs every Thursday at 9:00 AM ET.
 *
 * This aligns with the current process where Part 1 (data refresh) happens
 * first thing Thursday morning, and Part 2 (canvas creation) follows.
 *
 * To create this trigger after deploying:
 *   slack trigger create --trigger-def triggers/scheduled_trigger.ts
 *
 * UPDATE the channel_id below to your target Slack channel.
 */
const ScheduledTrigger: Trigger<typeof DealNotesWorkflow.definition> = {
  type: TriggerTypes.Scheduled,
  name: "Weekly Deal Notes (Scheduled)",
  description:
    "Automatically creates the TMT Deal Notes canvas every Thursday at 9:00 AM ET",
  workflow: `#/workflows/${DealNotesWorkflow.definition.callback_id}`,
  inputs: {
    // ┌─────────────────────────────────────────────────────┐
    // │  UPDATE THIS to your actual Slack channel ID        │
    // │  e.g. "C0123456789"                                 │
    // └─────────────────────────────────────────────────────┘
    channel_id: { value: "C06K7BP34AD" },
  },
  schedule: {
    // First run — set to the next upcoming Thursday
    start_time: "2026-03-19T14:00:00Z", // 9:00 AM ET = 14:00 UTC
    timezone: "America/New_York",
    frequency: {
      type: "weekly",
      repeats_every: 1,
      on_days: ["Thursday"],
    },
  },
};

export default ScheduledTrigger;
