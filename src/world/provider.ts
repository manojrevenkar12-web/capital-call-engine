import { Rng } from "./rng";

/**
 * The e-mail provider as the world runs it. It fails the way real providers do: refusing
 * a message, timing out after accepting it, timing out before accepting it. It keeps the
 * mailbox, so the evaluation can count how many times each notice actually arrived.
 * Shaped like the service's Mailer interface without importing it.
 */

export class ProviderError extends Error {
  constructor(readonly kind: "not_sent" | "ambiguous", message: string) {
    super(message);
  }
}

export interface Delivered {
  key: string;
  to: string;
  subject: string;
  body: string;
  seq: number;
}

export class SimProvider {
  readonly delivered: Delivered[] = [];
  private readonly byKey = new Map<string, string>();
  private seq = 0;
  attempts = 0;
  faults = { unavailable: 0, ambiguousDelivered: 0, ambiguousLost: 0 };

  constructor(
    private readonly rng: Rng,
    private readonly p: { unavailable: number; ambiguous_delivered: number; ambiguous_lost: number },
    /** Builds the error type the service understands; the evaluation passes the service's MailError. */
    private readonly makeError: (kind: "not_sent" | "ambiguous", msg: string) => Error,
  ) {}

  async send(m: { idempotencyKey: string; to: string; subject: string; body: string }): Promise<{ providerId: string }> {
    this.attempts += 1;
    const r = this.rng.next();
    if (r < this.p.unavailable) {
      this.faults.unavailable += 1;
      throw this.makeError("not_sent", "503 service unavailable");
    }
    if (r < this.p.unavailable + this.p.ambiguous_lost) {
      this.faults.ambiguousLost += 1;
      throw this.makeError("ambiguous", "timeout");
    }
    this.seq += 1;
    const id = `msg-${this.seq}`;
    this.delivered.push({ key: m.idempotencyKey, to: m.to, subject: m.subject, body: m.body, seq: this.seq });
    if (!this.byKey.has(m.idempotencyKey)) this.byKey.set(m.idempotencyKey, id);
    if (r < this.p.unavailable + this.p.ambiguous_lost + this.p.ambiguous_delivered) {
      this.faults.ambiguousDelivered += 1;
      throw this.makeError("ambiguous", "timeout after accept");
    }
    return { providerId: id };
  }

  async lookup(key: string): Promise<string | null> {
    return this.byKey.get(key) ?? null;
  }
}
