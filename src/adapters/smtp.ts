import nodemailer from "nodemailer";
import type { Config } from "../core/config.js";
import type { CredentialStore } from "../core/credentials.js";
import type { AccessContext } from "../core/context.js";
import { AppError } from "../core/errors.js";
export class SMTPAdapter {
  constructor(
    private config: Config,
    private credentials: CredentialStore,
    private endpoint?: {
      host: string;
      port: 465 | 587;
      username: string;
      credential_ref: string;
    },
  ) {}
  async send(ctx: AccessContext, raw: Buffer, recipients: string[]) {
    if (!this.config.sender_address || !this.config.imap_username)
      throw new AppError(
        "NOT_CONFIGURED",
        "iCloud mail sending is not configured.",
      );
    ctx.signal.throwIfAborted();
    const transport = nodemailer.createTransport({
      host: this.endpoint?.host ?? "smtp.mail.me.com",
      port: this.endpoint?.port ?? 587,
      secure: this.endpoint?.port === 465,
      requireTLS: true,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      auth: {
        user: this.endpoint?.username ?? this.config.imap_username,
        pass: await this.credentials.get(
          this.endpoint?.credential_ref ?? this.config.credential_ref,
          ctx.signal,
        ),
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const abort = () => transport.close();
    ctx.signal.addEventListener("abort", abort, { once: true });
    try {
      ctx.assert_current?.();
      const r = await transport.sendMail({
        envelope: { from: this.config.sender_address, to: recipients },
        raw,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return {
        status: "upstream_accepted",
        accepted_count: r.accepted.length,
        rejected_count: r.rejected.length,
        message_id: r.messageId,
        delivered: false,
        read: false,
      };
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      transport.close();
    }
  }
}
