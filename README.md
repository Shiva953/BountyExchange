# Bounty Exchange

Performance-based USDC bounties for Solana token volume. A sponsor escrow-locks a reward against a specific trader wallet; the trader accepts, generates swap volume on a target mint, and gets paid on-chain if they hit volume and hold requirements before expiry.

## Problem

Token projects need measurable trading activity from known wallets (KOLs, market makers, traders). Off-platform deals have no escrow, no objective settlement, and no way to enforce volume or hold terms. Bounty Exchange wraps that arrangement in an Anchor program with USDC escrow and an off-chain volume oracle that feeds finalization.

## How It Works

1. **Create** (`create_deal`): Sponsor deposits USDC into a program-owned escrow vault and sets token mint, target trader, reward, volume target, optional min buy size, expiration window, and hold duration.
2. **Accept** (`accept_deal`): Only the designated trader can accept. Accepted deals sync to Postgres; the trader is registered on Helius webhooks for swap monitoring.
3. **Track**: Backend parses swap transactions via Helius Enhanced Transactions API, computes USD volume on the target mint, and caches results in Redis.
4. **Finalize** (`finalize_deal`): Authorized crank submits `volume_at_end_time` and `hold_duration_at_end_time`. Program pays the trader on pass or refunds the creator on fail. Unaccepted deals past expiry are cancelled permissionlessly (`cancel_expired_deal`).

Win condition: volume target **and** hold duration met before expiration. Early finalization triggers once both are satisfied.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, Tailwind, shadcn/ui, Solana Wallet Adapter (Phantom, Solflare) |
| On-chain | Anchor 0.32 (`bounty_exchange_program`), SPL Token (USDC escrow) |
| Backend | Next.js API routes, node-cron (dev) / Railway HTTP crons (prod) |
| Database | PostgreSQL via Prisma (Neon adapter) |
| Cache | Upstash Redis (in-memory fallback) |
| Notifications | Telegram Bot API (trader DMs + system channel) |
| Deploy | Railway |

### RPCs and External Services

| Service | Env var | Usage |
|---------|---------|-------|
| Helius Devnet RPC | `HELIUS_DEVNET_URL` / `NEXT_PUBLIC_HELIUS_DEVNET_URL` | Wallet txs, deal reads/writes, program interaction |
| Helius Mainnet RPC | `HELIUS_MAINNET_URL` | Token metadata |
| Helius Enhanced Transactions | `HELIUS_API_KEY`, `HELIUS_MAINNET_API_BASE` | Swap parsing and USD volume calculation |
| Helius Webhooks | `HELIUS_WEBHOOK_ID`, `DEV_HELIUS_WEBHOOK_ID`, `HELIUS_WEBHOOK_SECRET` | Real-time swap events on trader wallets |
| PostgreSQL | `DATABASE_URL` | Traders, deals, notification prefs/logs |
| Upstash Redis | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Volume cache |
| Crank keypair | `CRANK_PRIVATE_KEY` | Signs `finalize_deal` and cancel txs |
| Cron auth | `CRON_SECRET` | Protects `/api/cron` in production |

Program: `5voynNZLcD5xDBmhfvegNK9ySLsjZRU4HdhmC5KQSaSi` (devnet). USDC mint: `GqiwdrC5ybCCmtvG2Yir9CVfsENjYQTHwKB9B2y3mi5f`.

Volume oracle reads **mainnet** swap history via Helius; deal settlement runs on **devnet**.

## Program Architecture

The Anchor program is a blackbox relative to this repo. Integration happens through the checked-in IDL (`src/program/IDL.json`) and TS instruction builders (`src/program/instructions/`). Rust instruction sources are mirrored temporarily in `instructions/` for reference; canonical source is the program repo.

**Program repo:** [github.com/Shiva953/bounty-exchange-program](https://github.com/Shiva953/bounty-exchange-program)

### Accounts

| Account | Derivation / role |
|---------|-------------------|
| **Deal PDA** | `seeds = ["deal", creator, deal_id_le_bytes]` |
| **Escrow vault** | USDC ATA, authority = Deal PDA |
| **Fee wallet** | Hardcoded `FEE_WALLET`, receives protocol fee at creation |

**Deal state** (`instructions/create_deal.rs`): `deal_id`, `creator`, `token` (target mint), `trader`, `reward_amount`, `target_volume`, `min_buy_volume`, `expiration_window_in_hours`, `hold_duration_in_hours`, `escrow_vault`, `created_at`, `is_active`, `is_accepted`, `outcome`, `volume_completed_usd`.

### Instructions

**`create_deal`** (sponsor signs)
- Inits Deal PDA + escrow ATA
- Validates: no self-target, reward >= 200 USDC, `min_buy_volume < target_volume`, expiry/hold between 1h and 720h, target volume cap
- Transfers **10% protocol fee** to `FEE_WALLET`, then full `reward_amount` to escrow

**`accept_deal`** (target trader signs)
- Requires `deal.trader == signer`, active, not yet accepted
- Sets `is_accepted = true`

**`finalize_deal`** (crank signs, must match hardcoded `CRANK_AUTHORITY`)
- Args: `volume_at_end_time`, `hold_duration_at_end_time` (supplied by off-chain oracle)
- Pass if `volume >= target_volume` **and** `hold_duration >= hold_duration_in_hours`
- **Pass:** full escrow to trader ATA, close vault, `outcome = true`
- **Fail:** full escrow to creator ATA, close vault, `outcome = false`
- Sets `is_active = false`, stores `volume_completed_usd`

**`cancel_expired_deal`** (permissionless, any payer)
- Only for unaccepted deals past `created_at + expiration_window`
- Refunds creator, closes escrow, sets `is_active = false`

**`withdraw_from_escrow`** (hardcoded `ADMIN` only)
- Active deal, only after expiration window elapsed
- Escrow to admin ATA (emergency recovery), closes vault

### State machine

```
                    create_deal
                        |
                        v
              +-------------------+
              |  Open (unaccepted)|
              +-------------------+
                 |            |
       accept_deal|            | cancel_expired_deal
                 |            | (past expiry)
                 v            v
              +-------------------+     +-----------+
              | Active (accepted) |     | Cancelled |
              +-------------------+     +-----------+
                 |            |
    finalize pass|            | finalize fail
                 v            v
              +------+     +------+
              | Won  |     | Lost |
              +------+     +------+

  Active deal past expiry (stuck) --> withdraw_from_escrow (admin)
```

The program never parses DEX swaps. Volume and hold duration are attested off-chain (Helius) and submitted by the crank at finalization.

## App Architecture

```
┌─────────────┐     wallet sign      ┌──────────────────────┐
│   Browser   │ ───────────────────► │  Anchor Program      │
│  (Next.js)  │ ◄─── deal accounts ─ │  (USDC escrow)       │
└──────┬──────┘                      └──────────┬───────────┘
       │ API                                    │ finalize
       ▼                                        ▼
┌─────────────┐   volume calc    ┌──────────────────────┐
│  API Routes │ ◄──────────────► │  Helius (RPC + API)  │
│  + Cron     │   webhooks       │  Enhanced Txs        │
└──────┬──────┘                  └──────────────────────┘
       │
       ├── PostgreSQL (deal index, traders, notifications)
       ├── Redis (volume cache)
       └── Telegram (trader alerts, wallet linking)
```

**On-chain** owns escrow, deal state, and settlement. **Off-chain** owns volume measurement; the crank is the bridge at finalization.

## App Surfaces

| Route | Purpose |
|-------|---------|
| `/` | Open bounties, create bounty, trader index |
| `/deal/[dealPubkey]` | Deal detail, accept, live volume progress (SSE) |
| `/sponsor` | Sponsor dashboard and campaigns |
| `/[walletAddress]/deals` | Trader deal board |
| `/verify/[code]` | Telegram wallet linking |

Trader directory synced from Axiom (`scripts/syncAxiomTraders.ts`).

## Development

```bash
bun install
bun run dev          # Next.js on :3000
bun run bot:dev      # Telegram polling (local, no webhook)
bun run db:migrate   # Prisma migrations
```

In dev, cron runs in-process via `instrumentation.ts`. In production (`CRON_SECRET` set), Railway triggers `/api/cron?job=...` on schedule (volume sync, expiry checks, reconciliation, notifications).
