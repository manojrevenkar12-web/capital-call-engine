import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CONFIG } from "../tokens";
import type { EngineConfig } from "../config";

/**
 * Verifies the bearer token FusionAuth issues and takes the fund manager (tenant) from it.
 * The tenant is never read from the URL or the body, so one manager cannot name another's.
 */

export const PUBLIC = "cce:public";
export const Public = () => SetMetadata(PUBLIC, true);

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signToken(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string, issuer: string, audience: string, nowSec: number): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  if (header.alg !== "HS256") throw new Error(`unexpected alg ${header.alg}`);
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (claims.iss !== issuer) throw new Error("wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new Error("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp < nowSec) throw new Error("expired");
  return claims;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: EngineConfig,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) throw new UnauthorizedException("bearer token required");
    const secret = process.env.CCE_JWT_SECRET;
    if (!secret) throw new UnauthorizedException("auth is not configured");
    try {
      const claims = verifyToken(header.slice(7), secret, this.config.auth.issuer, this.config.auth.audience, Math.floor(Date.now() / 1000));
      const tenant = claims[this.config.auth.tenant_claim];
      if (typeof tenant !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new Error("no tenant in token");
      req.tenant = tenant;
      req.subject = String(claims.sub ?? "unknown");
      return true;
    } catch (e) {
      throw new UnauthorizedException((e as Error).message);
    }
  }
}

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().tenant);
export const Subject = createParamDecorator((_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest().subject);
