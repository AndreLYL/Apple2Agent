import type { Config } from "../core/config.js";
import {
  authorize,
  requireGrant,
  type AccessContext,
} from "../core/context.js";
import type { KeychainCredentialStore } from "../core/credentials.js";
import type { NativeBridge } from "../core/native.js";
import { ApprovalStore } from "../core/approvals.js";
import { References } from "../core/references.js";
import { HubState } from "../core/hub-state.js";
import { AppError } from "../core/errors.js";
import { AdvancedIMAPAdapter } from "../adapters/imap-advanced.js";
import { SMTPAdapter } from "../adapters/smtp.js";
import { MailModule } from "./mail.js";
import type { Module, ToolRegistry } from "./types.js";
type Scope = {
  id: string;
  name: string;
  refs: References;
  module: MailModule;
  approvals: ApprovalStore;
};
/** Each protocol connection has an independent account namespace. No UID or native Mail id is reinterpreted across backends. */
export class MailHub implements Module {
  domain = "mail" as const;
  tools: ToolRegistry = {};
  scopes: Scope[] = [];
  constructor(
    private config: Config,
    private primary: MailModule,
    credentials: KeychainCredentialStore,
    native: NativeBridge,
    private state: HubState,
    private primaryApprovals: ApprovalStore,
    key: () => Promise<Buffer>,
  ) {
    for (const c of config.hub?.mail_connections ?? []) {
      const cfg: Config = {
        ...config,
        account_id: c.id,
        imap_username: c.username,
        imap_host: c.imap_host,
        credential_ref: c.credential_ref,
        sender_address: c.sender,
        drafts_folder: c.drafts_folder,
      };
      const refs = new References(cfg, cfg.ref_key),
        approvals = new ApprovalStore(state, cfg, key);
      const imap = new AdvancedIMAPAdapter(cfg, credentials, undefined, true),
        smtp = new SMTPAdapter(cfg, credentials, {
          host: c.smtp_host,
          port: c.smtp_port,
          username: c.smtp_username ?? c.username,
          credential_ref: c.smtp_credential_ref ?? c.credential_ref,
        });
      this.scopes.push({
        id: c.id,
        name: c.name,
        refs,
        approvals,
        module: new MailModule(
          cfg,
          imap,
          smtp,
          native,
          refs,
          state,
          approvals,
          {
            "\\Drafts": c.drafts_folder,
            "\\Sent": c.sent_folder,
            "\\Trash": c.trash_folder,
          },
        ),
      });
    }
    for (const [name, tool] of Object.entries(primary.tools)) {
      this.tools[name] = {
        ...tool,
        run: async (ctx, args) => {
          authorize(ctx, this.config, tool.capability);
          if (name === "mail_list_accounts") {
            // Protocol grants must not accidentally trigger native Mail discovery.
            const baseCtx = {
              ...ctx,
              grants: {
                ...ctx.grants,
                mail_accounts: ctx.grants?.mail_accounts?.filter(
                  (x) => !x.startsWith("imap:"),
                ),
              },
            };
            const base = await tool.run(baseCtx, args);
            const accounts = [...base.accounts];
            for (const scope of this.scopes) {
              if (!ctx.grants?.mail_accounts?.includes(`imap:${scope.id}`))
                continue;
              const out = await scope.module.tools[name]!.run(
                this.scopeContext(ctx, scope),
                args,
              );
              accounts.push(
                ...out.accounts.map((a: any) => ({
                  ...a,
                  backend: "imap-smtp",
                  name: scope.name,
                  connection_id: scope.id,
                })),
              );
            }
            return { accounts };
          }
          const scope = args.account_id
            ? this.scopeForAccount(args.account_id)
            : args.action_id
              ? this.scopeForAction(ctx, args.action_id)
              : undefined;
          return scope
            ? scope.module.tools[name]!.run(this.scopeContext(ctx, scope), args)
            : tool.run(ctx, args);
        },
      };
    }
  }
  private scopeForAccount(token: string) {
    for (const scope of this.scopes) {
      try {
        scope.refs.decode("mail-account", token);
        return scope;
      } catch {}
    }
    return undefined;
  }
  scopeForAction(ctx: AccessContext, id: string) {
    const a = this.state.get<any>(`approval:${id}`);
    if (!a || a.owner_id !== ctx.owner_id) return undefined;
    return this.scopes.find((s) => s.id === a.account_id);
  }
  scopeContext(ctx: AccessContext, scope: Scope) {
    ctx.signal.throwIfAborted();
    if (
      ctx.owner_id !== this.config.owner_id ||
      ctx.account_id !== this.config.account_id
    )
      throw new AppError("PERMISSION_DENIED", "Wrong hub identity.");
    requireGrant(ctx, "mail_accounts", `imap:${scope.id}`);
    return {
      ...ctx,
      account_id: scope.id,
      grants: { ...ctx.grants, mail_accounts: ["icloud:primary"] },
    };
  }
  async status(ctx: AccessContext) {
    const r = await this.primary.status(ctx);
    return {
      ...r,
      protocol_connections: this.scopes
        .filter((s) => ctx.grants?.mail_accounts?.includes(`imap:${s.id}`))
        .map((s) => ({
          name: s.name,
          backend: "imap-smtp",
          status: "configured_not_live_verified",
        })),
    };
  }
}
/** Trusted local review routes to the same connection that prepared the immutable action. */
export class HubApprovals extends ApprovalStore {
  mailHub?: MailHub;
  private route(ctx: AccessContext, id: string) {
    const s = this.mailHub?.scopeForAction(ctx, id);
    return s
      ? { store: s.approvals, ctx: this.mailHub!.scopeContext(ctx, s) }
      : undefined;
  }
  override status(ctx: AccessContext, id: string) {
    const r = this.route(ctx, id);
    return r ? r.store.status(r.ctx, id) : super.status(ctx, id);
  }
  override review(
    ctx: AccessContext,
    id: string,
    reviewer: (op: string, payload: unknown) => Promise<boolean>,
  ) {
    const r = this.route(ctx, id);
    return r
      ? r.store.review(r.ctx, id, reviewer)
      : super.review(ctx, id, reviewer);
  }
  override discard(ctx: AccessContext, id: string) {
    const r = this.route(ctx, id);
    return r ? r.store.discard(r.ctx, id) : super.discard(ctx, id);
  }
}
