import "reflect-metadata";
import { createApp } from "./app.module";
import { loadConfig } from "./config";
import { Db } from "./db/db";
import { LogMailer, SendGridMailer } from "./outbox/mailer";
import { OutboxService } from "./outbox/outbox.service";

async function main() {
  const config = loadConfig();
  const url = process.env.CCE_DATABASE_URL;
  if (!url) throw new Error("CCE_DATABASE_URL is required");
  const db = new Db(url);
  if (process.env.CCE_MIGRATE_ON_START === "true") await db.migrate();
  const key = process.env.CCE_SENDGRID_API_KEY;
  const mailer = key ? new SendGridMailer(key, config) : new LogMailer();
  const app = await createApp({ db, config, mailer });

  let timer: NodeJS.Timeout | null = null;
  if (config.server.dispatch_interval_ms > 0) {
    const outbox = app.get(OutboxService);
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await outbox.dispatch();
      } catch (e) {
        console.error("dispatch failed", e);
      } finally {
        running = false;
      }
    }, config.server.dispatch_interval_ms);
  }
  const shutdown = async () => {
    if (timer) clearInterval(timer);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await app.listen(Number(process.env.PORT ?? config.server.port), "0.0.0.0");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
