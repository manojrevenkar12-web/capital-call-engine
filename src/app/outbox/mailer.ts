import { EngineConfig } from "../config";

export interface OutgoingMail {
  idempotencyKey: string;
  to: string;
  subject: string;
  body: string;
}

/**
 * How a send can fail. `not_sent` is certain the provider did not take the message;
 * `permanent` will never succeed (a rejected address); `ambiguous` means it may have
 * gone out, so the provider is asked before the message is sent again.
 */
export class MailError extends Error {
  constructor(readonly kind: "not_sent" | "permanent" | "ambiguous", message: string) {
    super(message);
  }
}

export interface Mailer {
  send(m: OutgoingMail): Promise<{ providerId: string }>;
  /** The provider's id for a message carrying this key, or null if it never arrived. */
  lookup(idempotencyKey: string): Promise<string | null>;
}

/** Development mailer: writes to the log and remembers what it sent. */
export class LogMailer implements Mailer {
  private readonly sent = new Map<string, string>();
  async send(m: OutgoingMail) {
    const id = `log-${this.sent.size + 1}`;
    this.sent.set(m.idempotencyKey, id);
    console.log(`[mail] to=${m.to} subject="${m.subject}" key=${m.idempotencyKey}`);
    return { providerId: id };
  }
  async lookup(key: string) {
    return this.sent.get(key) ?? null;
  }
}

/**
 * SendGrid v3. The idempotency key travels as a custom argument, which is how the Email
 * Activity API finds an earlier attempt. Network errors, timeouts and 5xx are ambiguous;
 * 429 means not sent; other 4xx are permanent.
 */
export class SendGridMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly config: EngineConfig,
  ) {}

  private async request(path: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.config.sendgrid.timeout_ms);
    try {
      return await fetch(`${this.config.sendgrid.base_url}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      });
    } finally {
      clearTimeout(t);
    }
  }

  async send(m: OutgoingMail) {
    let res: Response;
    try {
      res = await this.request("/v3/mail/send", {
        method: "POST",
        body: JSON.stringify({
          personalizations: [{ to: [{ email: m.to }], custom_args: { idempotency_key: m.idempotencyKey } }],
          from: { email: this.config.outbox.from },
          subject: m.subject,
          content: [{ type: "text/plain", value: m.body }],
        }),
      });
    } catch (e) {
      throw new MailError("ambiguous", `network: ${(e as Error).message}`);
    }
    if (res.status === 202) return { providerId: res.headers.get("x-message-id") ?? m.idempotencyKey };
    if (res.status === 429) throw new MailError("not_sent", "rate limited");
    if (res.status >= 500) throw new MailError("ambiguous", `provider ${res.status}`);
    throw new MailError("permanent", `provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  async lookup(key: string) {
    const q = encodeURIComponent(`unique_args['idempotency_key']="${key}"`);
    const res = await this.request(`/v3/messages?limit=1&query=${q}`, { method: "GET" });
    if (!res.ok) throw new MailError("ambiguous", `lookup failed: ${res.status}`);
    const body = (await res.json()) as { messages?: { msg_id: string }[] };
    return body.messages?.[0]?.msg_id ?? null;
  }
}
