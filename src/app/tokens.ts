/** Injection tokens. Injection is explicit so the code runs the same under tsc and under esbuild-based test runners. */
export const CONFIG = Symbol("CONFIG");
export const DB = Symbol("DB");
export const MAILER = Symbol("MAILER");
export const METRICS = Symbol("METRICS");
