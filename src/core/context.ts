import { AppError } from "./errors.js";
export type Capability =
  | "calendar:read"
  | "calendar:create"
  | "calendar:update"
  | "calendar:delete"
  | "mail:read"
  | "mail:draft:create"
  | "mail:write"
  | "mail:send"
  | "reminders:read"
  | "reminders:write"
  | "reminders:delete"
  | "contacts:read"
  | "contacts:write"
  | "contacts:delete"
  | "notes:read"
  | "notes:write"
  | "notes:delete"
  | "drive:read"
  | "drive:write"
  | "drive:delete"
  | "messages:read"
  | "messages:send";
export const allCapabilities: Capability[] = [
  "calendar:read",
  "calendar:create",
  "calendar:update",
  "calendar:delete",
  "mail:read",
  "mail:draft:create",
  "mail:write",
  "mail:send",
  "reminders:read",
  "reminders:write",
  "reminders:delete",
  "contacts:read",
  "contacts:write",
  "contacts:delete",
  "notes:read",
  "notes:write",
  "notes:delete",
  "drive:read",
  "drive:write",
  "drive:delete",
  "messages:read",
  "messages:send",
];
export type Domain =
  | "calendar"
  | "mail"
  | "reminders"
  | "contacts"
  | "notes"
  | "drive"
  | "messages";
export type Profile = "legacy" | "all" | "calendar" | "readonly";
export interface ResourceGrants {
  mail_accounts?: readonly string[];
  reminder_sources?: readonly string[];
  reminder_lists?: readonly string[];
  denied_reminder_lists?: readonly string[];
  addressbooks?: readonly string[];
  notes_accounts?: readonly string[];
  notes_folders?: readonly string[];
  denied_notes_folders?: readonly string[];
  drive_roots?: readonly string[];
  sms_read_scope?: "selected" | "all_sms";
  message_chats?: readonly string[];
  message_recipients?: readonly string[];
  message_never_send?: readonly string[];
}
export type ResourceGrantKind = Exclude<keyof ResourceGrants, "sms_read_scope">;
export interface AccessContext {
  owner_id: string;
  account_id: string;
  actor_id: string;
  capabilities: ReadonlySet<Capability>;
  signal: AbortSignal;
  assert_current?: () => void;
  grants?: ResourceGrants;
}
export function profileCapabilities(
  profile: Profile,
  allowed: readonly Capability[] = allCapabilities,
) {
  return new Set(
    allowed.filter((cap) => {
      if (profile === "legacy")
        return [
          "calendar:read",
          "calendar:create",
          "mail:read",
          "mail:draft:create",
        ].includes(cap);
      if (profile === "calendar") return cap.startsWith("calendar:");
      if (profile === "readonly") return cap.endsWith(":read");
      return true;
    }),
  );
}
export function requireGrant(
  ctx: AccessContext,
  kind: ResourceGrantKind,
  id: string,
) {
  const ids = ctx.grants?.[kind];
  if (!Array.isArray(ids) || !ids.includes(id))
    throw new AppError(
      "PERMISSION_DENIED",
      "The resource is outside the configured grant.",
      "Choose an authorized resource in local setup.",
    );
}
export interface Identity {
  owner_id: string;
  account_id: string;
}
export function authorize(
  ctx: AccessContext,
  identity: Identity,
  capability: Capability,
) {
  ctx.signal.throwIfAborted();
  ctx.assert_current?.();
  if (
    ctx.owner_id !== identity.owner_id ||
    ctx.account_id !== identity.account_id ||
    !ctx.capabilities.has(capability)
  )
    throw new AppError(
      "PERMISSION_DENIED",
      "This caller is not allowed to perform this operation.",
      "Use an authorized local configuration.",
    );
}
