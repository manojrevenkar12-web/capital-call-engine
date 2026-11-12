# Working on capital-call-engine

## Fast feedback

```bash
./scripts/mysql-local.sh               # MySQL 8 on 127.0.0.1:3307 (CI uses a mysql:8.0 service)
npm test                               # 25 tests; the service ones need MySQL and fail without it
npm run typecheck
npx tsx scripts/evaluate.ts --check    # the committed dev report is what the code produces (~4 min)
npx tsx scripts/readme.ts --check      # the README numbers come from the reports
cd web && npm test && npm run build
```

Run them before a commit.

## Invariants

1. **Nothing that serves reads the truth.** `src/world/` makes the funds, investors, bank,
   provider and the answer key. Nothing in `src/app`, `src/domain` or `src/money` imports it,
   and the world does not import the service; `test/invariants.test.ts` checks both.
2. **Money is integer cents, splits are a rule.** Largest remainder, ties to the lowest
   investor number, every split sums to its amount. New arithmetic goes through
   `src/money/money.ts`.
3. **A notice exists if and only if its message is queued.** Write the outbox row in the
   same transaction. Never send from a request handler.
4. **An effect is done when it is confirmed.** An ambiguous send is looked up before it is
   sent again.
5. **A tenant only sees its own rows.** Every query filters on `tenant_id`; another
   manager's fund is a 404. New tables carry `tenant_id`.
6. **Fund events are in date order and serialised by the fund row lock.**
7. **Settings live in config.** Fund economics are stored per fund (defaults in
   `config/engine.toml`); tolerances, retries and windows are in config, not code.
8. **Reports are generated.** `reports/*.json` come from `scripts/evaluate.ts`, the README
   results block from `scripts/readme.ts`, the demo data from `scripts/export-demo.ts`.

## The held-out rule

`npx tsx scripts/evaluate.ts --heldout` runs seeds 101 and 102 once and writes
`reports/heldout/first_run.json`. It refuses to run again. That file is the result to quote.
Changes after it are measured on the development seeds only.
