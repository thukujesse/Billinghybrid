# JTM — Hybrid ISP Billing System

A billing platform for a Mikrotik/PPPoE/hotspot ISP, implementing the logic from
the **Hybrid ISP Billing Architecture** (PHPNuxBill feature set on a scalable
backbone). This first iteration delivers the **core billing domain, vouchers &
hotspot, payments (M-Pesa/Stripe), and an admin + customer portal UI**.

It's built as a **modular monolith**: each domain (`billing`, `payments`,
`vouchers`, …) is an isolated module that mirrors a microservice in the
architecture doc, so any module can be split into its own service later without
touching the call sites.

```
┌──────────────────────────┐      ┌──────────────────────────────────────┐
│  web/  Next.js 14         │ ───▶ │  api/  Express + TypeScript           │
│  Admin dashboard +        │ REST │  ├─ domains/ (business services)      │
│  Customer self-service    │      │  ├─ Postgres (money in integer cents) │
└──────────────────────────┘      │  └─ in-process event bus (Kafka stub) │
                                   └──────────────────────────────────────┘
```

## Tech stack

| Layer     | Choice                                              |
|-----------|-----------------------------------------------------|
| API       | Node.js 20+, TypeScript, Express, Zod validation    |
| Database  | PostgreSQL 16 (raw SQL + migrations, `pg`)          |
| Web       | Next.js 14 (App Router), React 18                   |
| Tests     | Vitest (unit + DB integration)                      |

Money is **always stored and computed in integer minor units (cents)** — never
floats. See `api/src/lib/money.ts`.

## Quick start

```bash
# 1. Install
npm install

# 2. Start Postgres (Docker) — or point DATABASE_URL at an existing DB
docker compose up -d db
cp .env.example .env          # adjust if needed

# 3. Create schema + demo data
npm run migrate
npm run seed

# 4. Run API (:4000) and web (:3000) in two terminals
npm run dev:api
npm run dev:web
```

Open the **admin dashboard** at http://localhost:3000 and the **customer
portal** at http://localhost:3000/portal (look up the seeded number
`254712000001`).

> Payments run in **simulation mode** until you add real M-Pesa Daraja / Stripe
> credentials to `.env`. In simulation, an STK push returns a `checkoutRequestId`
> you confirm via `POST /api/payments/mpesa/callback` — exactly how Daraja's
> async callback would settle it in production.

## Domain modules (`api/src/domains`)

| Module          | Responsibility (architecture mapping)                                              |
|-----------------|------------------------------------------------------------------------------------|
| `plans`         | Prepaid / postpaid / hotspot packages: price, validity, data cap, FUP threshold    |
| `subscribers`   | Hotspot & PPPoE accounts; suspend/restore → Provisioning + events                  |
| `subscriptions` | Activating & extending a subscriber on a plan ("Plan Extend")                      |
| `wallet`        | User Balance / Wallet — **immutable ledger** with row-locked, atomic postings      |
| `tax`           | Per-region VAT (Kenya 16% = 1600 bps) applied to invoices                          |
| `billing`       | Invoices, the **monthly billing cycle**, and the **dunning engine** (3 strikes → suspend) |
| `purchases`     | **Buy a plan** from wallet, incl. **buy-for-a-friend** gifting                     |
| `credits`       | **Credit notes & adjustments** (NET-NEW) — applied to the wallet                   |
| `refunds`       | **Refund workflows** (NET-NEW) — full/partial, wallet / M-Pesa / manual            |
| `payments`      | M-Pesa STK Push + Stripe, **idempotent** confirmation, wallet credit               |
| `vouchers`      | Batch generation (debits reseller float) + redemption + commission                 |
| `resellers`     | Sub-dealer float wallets and commission rates                                      |
| `usage`         | Metering & **FUP enforcement** (alert at threshold, throttle at 100%)              |
| `provisioning`  | Network Integration stub — records intent; swap for Mikrotik RouterOS / RADIUS     |
| `notifications` | SMS / WhatsApp / Telegram / Email stubs, driven by events                          |
| `events`        | In-process event bus (Kafka stand-in) + `events` audit table                       |
| `reports`       | Dashboard & revenue analytics                                                      |

## Data flows implemented (from the architecture doc)

1. **Buy & redeem voucher** — `POST /vouchers/redeem` → activates subscription → provisions access → reseller commission.
2. **Monthly auto-billing** — `POST /billing/run-cycle` → invoice + VAT → charge wallet; failures feed dunning.
3. **FUP enforcement** — `POST /usage` accumulates bytes; emits alert at the plan threshold, throttles at 100%.
4. **Reseller buys voucher batch** — `POST /vouchers/batch` with `reseller_id` debits their float atomically.
5. **Suspend & restore** — `POST /subscribers/:id/suspend|restore` → Provisioning + customer/admin notifications.

Every state change emits a domain event (`payment.paid`, `subscriber.suspended`,
`usage.fup.exceeded`, …) that the Notification module reacts to — replace the bus
with Kafka and the producers/consumers stay identical.

## Tests

```bash
npm test
```

Covers money/VAT math (pure) plus DB-backed flows: ledger integrity, invoice +
tax + wallet settlement, reseller batch float debit + commission, M-Pesa
idempotency, FUP throttling, and dunning-driven suspension.

## API reference (selected)

| Method & path                          | Purpose                                  |
|----------------------------------------|------------------------------------------|
| `GET  /api/dashboard`                  | Aggregate stats for the admin home       |
| `POST /api/plans`                      | Create a plan                            |
| `POST /api/subscribers`                | Register a subscriber (auto-creates wallet) |
| `POST /api/subscribers/:id/suspend`    | Suspend (Flow 05)                        |
| `POST /api/invoices`                   | Create an invoice from line items        |
| `POST /api/billing/run-cycle`          | Run monthly auto-billing (Flow 02)       |
| `POST /api/billing/run-dunning`        | Run the dunning engine                   |
| `POST /api/payments/mpesa/stk`         | Initiate an M-Pesa STK push              |
| `POST /api/payments/mpesa/callback`    | Daraja callback / simulated confirmation |
| `POST /api/vouchers/batch`             | Generate a voucher batch (Flow 04)       |
| `POST /api/vouchers/redeem`            | Redeem a voucher (Flow 01)               |
| `POST /api/usage`                      | Ingest usage & enforce FUP (Flow 03)     |
| `POST /api/subscribers/:id/buy-plan`   | Buy/gift a plan from wallet              |
| `POST /api/credit-notes`               | Issue a credit note (credits wallet)     |
| `POST /api/refunds`                    | Refund a payment (full/partial)          |

## Roadmap (next slices)

Aligned with the architecture doc's later phases: FreeRADIUS + Mikrotik adapters
behind the Provisioning interface, TimescaleDB for high-volume CDRs, real Kafka,
auth/RBAC + OTP, PDF invoices to object storage, and Kubernetes deployment.
