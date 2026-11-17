/**
 * Discovery hints describe possible effects, not authorization. A tool that can
 * replace, move or remove existing data is destructive even when reversible.
 * Each write is reviewed explicitly; unknown writes get conservative defaults.
 * Replay guards describe effects for identical arguments, not identical results:
 * stale revisions, expired previews and uncertain outcomes may reject a retry.
 */
export const writeEffects: Readonly<
  Record<
    string,
    {
      destructive: boolean;
      replay: "request_id" | "action_id";
    }
  >
> = {
  // Calendar executeWrite/HubState receipts and the legacy draft operation store.
  calendar_create: { destructive: false, replay: "request_id" },
  calendar_update: { destructive: true, replay: "request_id" },
  calendar_delete: { destructive: true, replay: "request_id" },
  mail_draft_create: { destructive: false, replay: "request_id" },
  // Native mutations use HubState.write receipts; unknown outcomes only verify.
  reminders_create_reminder: { destructive: false, replay: "request_id" },
  reminders_update_reminder: { destructive: true, replay: "request_id" },
  reminders_complete_reminder: { destructive: true, replay: "request_id" },
  reminders_move_reminder: { destructive: true, replay: "request_id" },
  reminders_delete_reminder: { destructive: true, replay: "request_id" },
  reminders_create_list: { destructive: false, replay: "request_id" },
  reminders_update_list: { destructive: true, replay: "request_id" },
  reminders_delete_list: { destructive: true, replay: "request_id" },
  notes_create_note: { destructive: false, replay: "request_id" },
  notes_create_folder: { destructive: false, replay: "request_id" },
  notes_append_to_note: { destructive: false, replay: "request_id" },
  notes_update_note: { destructive: true, replay: "request_id" },
  notes_move_note: { destructive: true, replay: "request_id" },
  notes_delete_note: { destructive: true, replay: "request_id" },
  drive_write_file: { destructive: true, replay: "request_id" }, // Can overwrite.
  drive_create_folder: { destructive: false, replay: "request_id" },
  drive_move_item: { destructive: true, replay: "request_id" },
  drive_trash_item: { destructive: true, replay: "request_id" },
  // CardDAV mutations also use HubState receipts, in addition to ETag guards.
  contacts_create_contact: { destructive: false, replay: "request_id" },
  contacts_update_contact: { destructive: true, replay: "request_id" },
  contacts_delete_contact: { destructive: true, replay: "request_id" },
  contacts_create_group: { destructive: false, replay: "request_id" },
  contacts_update_group: { destructive: true, replay: "request_id" },
  contacts_delete_group: { destructive: true, replay: "request_id" },
  // Preparing an action only queues a frozen payload; it does not send it.
  imessage_send_message: { destructive: false, replay: "request_id" },
  mail_send_message: { destructive: false, replay: "request_id" },
  mail_send_draft: { destructive: false, replay: "request_id" },
  mail_unsubscribe_from_list: { destructive: false, replay: "request_id" },
  // ApprovalStore atomically claims action_id before release and retains a
  // tombstone even on uncertain outcomes. mail_execute_send can unsubscribe
  // or change the source message's Answered flag, so is not purely additive.
  imessage_execute_send: { destructive: false, replay: "action_id" },
  mail_execute_send: { destructive: true, replay: "action_id" },
  apple_action_discard: { destructive: true, replay: "action_id" },
  // Draft receipts, or ApprovalStore when reply/forward uses mode=send.
  mail_save_draft: { destructive: false, replay: "request_id" },
  mail_reply_to_message: { destructive: false, replay: "request_id" },
  mail_forward_message: { destructive: false, replay: "request_id" },
  mail_update_draft: { destructive: true, replay: "request_id" },
  // Organization uses durable receipts; bulk/undo derive stable per-item IDs.
  mail_mark_messages: { destructive: true, replay: "request_id" },
  mail_move_messages: { destructive: true, replay: "request_id" },
  mail_delete_messages: { destructive: true, replay: "request_id" },
  mail_create_folder: { destructive: false, replay: "request_id" },
  mail_update_folder: { destructive: true, replay: "request_id" },
  mail_delete_folder: { destructive: true, replay: "request_id" },
  mail_run_bulk_action: { destructive: true, replay: "request_id" },
  mail_undo_bulk_action: { destructive: true, replay: "request_id" },
};

export function toolAnnotations(
  name: string,
  readOnly: boolean,
  destructiveOverride?: boolean,
) {
  const effects = writeEffects[name];
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly
      ? false
      : (destructiveOverride ?? effects?.destructive ?? true),
    idempotentHint: readOnly || effects !== undefined,
    // Action bookkeeping is a closed local store. Apple resources may sync or
    // involve external participants even when accessed through a local helper.
    openWorldHint: !["apple_action_status", "apple_action_discard"].includes(
      name,
    ),
  };
}
