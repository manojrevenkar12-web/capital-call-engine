import { Db } from "../src/app/db/db";

async function main() {
  const db = new Db(process.env.CCE_DATABASE_URL ?? "mysql://root@127.0.0.1:3307/cce");
  const applied = await db.migrate();
  console.log(applied.length ? `applied ${applied.join(", ")}` : "schema up to date");
  await db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
