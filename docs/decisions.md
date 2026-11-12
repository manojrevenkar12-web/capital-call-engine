# Decisions

## Equalisation is done call by call, not as one lump

A later closing re-splits every earlier call as if the new investors had been there from the
first closing. The engine recomputes each call's split from the new commitments, takes the
difference from each investor's current share, and charges interest on each positive difference
from that call's date. Working per call is what keeps several closings right: an investor
admitted at the second closing pays for the calls before it, and is credited at the third.
A lump-sum version ("you owe x% of everything called so far, with interest from the first
call") overcharges interest whenever calls are spread out, and cannot say who to credit.

The LPA decides two things, and both are fund settings: the rate (simple, ACT/365), and whether
interest goes to the rebalanced investors or to the fund. Credits from a closing are netted
first against that closing's own catch-up and then against the investor's next notices.

## Rounding is a rule, written down

Every split uses largest remainder, with ties to the investor admitted first (lowest number).
Splits always sum to the amount; interest is rounded half up per investor per call and the
pool for a call is split the same way, so what payers pay equals what receivers get. The
domain code works on keys that sort by investor number, not on database ids, because a tie
going to a random UUID would be correct arithmetic and an indefensible answer to an investor.

## Money and the preferred return

Cents are integers. Products of commitments and amounts are BigInt. The preferred return
accrues as an exact fraction and is only rounded down to cents when it is paid, so rounding
does not compound across distributions. The answer key computes the same waterfall day by
day; the engine computes it interval by interval; they agree on all 36 development
distributions.

## Effects: a notice exists if and only if its e-mail is queued

The notice row and its outbox row are written in one transaction. The worker claims rows with
`FOR UPDATE SKIP LOCKED` and a lease, so any number of replicas can run it. Before calling the
provider it marks the row ambiguous; a crash leaves it ambiguous. An ambiguous row is never
re-sent blind: the worker asks the provider whether it already has a message with that key.
SendGrid carries the key as a custom argument and the Email Activity API finds it. Switching
the lookup off (the `blind_retry` ablation) sends 145 notices twice on the development worlds.

## Idempotent requests store their answer in the same transaction

Closings, calls and distributions take an `Idempotency-Key`. The key is inserted first; a
concurrent duplicate blocks on it until the first commits, then replays the stored response.
The same key with a different body is a 422. Each of these also locks the fund row, and fund
events must be in date order: a back-dated call would change equalisation already sent out.

## Payments: a reference decides, the account is a fallback, a person settles the rest

1. A valid structured RF reference that belongs to a notice of this fund.
2. A valid RF reference typed into the free text, read at whitespace boundaries.
3. The payer's known IBAN, when it belongs to one investor and either points at one open
   notice or the amount equals exactly one open notice.
4. Anything else goes to review with a reason.

Two safeguards came from the first evaluation run. Trimming characters off a mistyped reference
found the longest valid prefix, which once was another investor's valid reference (mod 97 makes
that about a 1 in 97 chance per typo); candidates now end only at token boundaries. And a
reference paid from an account the fund knows belongs to a different investor goes to a person.

## MySQL, not an ORM

The service uses mysql2 with plain SQL and a transaction helper that retries InnoDB deadlock
victims. Isolation is READ COMMITTED; the fund row lock gives the ordering that matters. The
query count per request is small and every query is visible in the service that runs it.

## Tenancy

The fund manager comes from the bearer token's tenant claim, never from the URL or body. Every
query filters on `tenant_id`, and a fund another manager owns answers 404 on every route (the
evaluation probes 112 routes across managers). MySQL has no row-level security, so this is
enforced in code and checked by tests and the evaluation, not by the database.

## What is not here

- Management fee calculation and fee equalisation (fee calls are treated like any other call).
- American (deal-by-deal) waterfalls, GP commitment, clawback.
- FusionAuth JWKS rotation: the guard verifies HS256; production would verify RS256 against
  the tenant's JWKS.
- Payouts (pain.001) for distributions: the notices are produced, the payment file is not.
- Terraform for EKS and RDS; the Kubernetes manifests assume the cluster exists.
