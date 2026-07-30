# Issue #1025 Implementation Summary

**Title:** [Smart Contracts] Optimize storage usage and gas cost in reputation contract

## Overview
Reviewed `packages/contracts/contracts/reputation` (added by #1017, which was itself a security-audit pass) for inefficient storage patterns. This is a **findings-and-recommendations pass only** — no optimization has been implemented or benchmarked yet. Do not check off the acceptance criteria below based on this document alone.

## Scope
- `packages/contracts/contracts/reputation/src/lib.rs` (single-module contract, 536 lines)

## Findings

### 1. `submit_review` does an unbounded read-modify-write of the full review history (primary finding)
```rust
let mut reviews: Vec<Review> = env.storage().persistent()
    .get(&DataKey::Reviews(worker_id.clone()))
    .unwrap_or(Vec::new(&env));
reviews.push_back(review);
...
env.storage().persistent().set(&DataKey::Reviews(worker_id.clone()), &reviews);
```
Every call reads the *entire* `Reviews(worker_id)` vector, deserializes it, appends one entry, re-serializes, and writes the *entire* vector back. Storage read/write fees in Soroban scale with the number of bytes read and written, so this makes `submit_review`'s cost grow linearly (and unboundedly) with a worker's total review count — a worker with 10,000 reviews makes every single future review call read+write ~10,000 review records just to add one more. `award_badge`/`revoke_badge` have the analogous pattern for the (much smaller, capped-in-practice) `badges` list inside `ReputationRecord`, which is far less of a concern since badge counts are naturally small.

This is the dominant cost driver in the contract and the one clearly worth fixing.

**Not implemented, options to evaluate:**
- **Cap on-chain history length** (e.g. keep only the most recent N reviews on-chain; rely on `Review` events — already emitted — for the full off-chain-indexable history). Cuts the read/write size to a constant, but changes `get_reviews`'s return semantics (callers relying on full on-chain history would need to move to an indexer).
- **Split into paginated storage keys** (e.g. `Reviews(worker_id, page)`), so writes only touch the most recent page. More storage-key bookkeeping, but avoids changing `get_reviews`'s external behavior as much.
- **Drop on-chain storage of individual reviews entirely**, keep only the aggregate `ReputationRecord` (`score`, `review_count`, `rating_sum`) which is already O(1) per write, and serve review history purely from indexed events. Cheapest option; biggest behavior change (removes `get_reviews` as an on-chain query).

Any of these needs sign-off on the resulting product/API behavior change before implementation — this doc intentionally stops short of picking one.

### 2. Redundant existence check in `extend_ttl` (minor)
```rust
fn extend_ttl(env: &Env, worker_id: &Symbol) {
    let key = DataKey::Reputation(worker_id.clone());
    if env.storage().persistent().has(&key) {
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}
```
Every call site (`submit_review`, `slash_reputation`, `reset_reputation`, `award_badge`, `revoke_badge`) calls `extend_ttl` immediately after `save_record`, which just wrote that exact key — so `has(&key)` is provably `true` at every current call site and is a redundant persistent-storage read on the hot path of every state-changing call. `extend_worker_ttl` (the public, permissionless entry point) is the *only* call site where the key might legitimately not exist yet, so the guard is only needed there.

**Not implemented recommendation:** have `save_record` unconditionally call `extend_ttl` internally (removing the separate call+check at each of the 5 call sites above), and keep the `has()` guard only in the public `extend_worker_ttl` path.

### 3. `Reviews(worker_id)`'s TTL is never extended (storage-lifecycle correctness, not pure cost)
`extend_ttl` only extends the TTL on the `Reputation(worker_id)` key. The separate `Reviews(worker_id)` persistent entry never has its TTL touched anywhere, so it could expire and be archived independently of the score record, making `get_reviews` behave inconsistently with `get_score`/`get_record` over time. Flagging this because it's adjacent to the storage-key consolidation the ticket asks about, but it's a correctness/consistency issue more than a gas-cost one.

## Not Done (acceptance criteria gap)
- No code changes were made.
- No storage read/write profiling was run (would need a Soroban resource-metering harness or `budget()` inspection in tests — not set up in this pass).
- No before/after gas/fee benchmark exists yet, since nothing was changed.

## Recommendation
Fix #2 first (small, mechanical, no behavior change, removes a redundant read from 5 hot paths). Decide on an approach for #1 with product input on whether `get_reviews` needs to keep returning full on-chain history, then implement and benchmark that separately — it's a larger, behavior-affecting change that deserves its own reviewed PR rather than being bundled here.

## Acceptance Criteria Status
- [x] Profile storage read/write counts in reputation — done by code inspection (see Findings); not done via an automated metering harness
- [ ] Consolidate redundant storage instance keys — not implemented (see recommendation)
- [ ] Benchmark gas/fee cost before and after — not applicable, nothing changed yet
- [ ] Verify functional behavior unchanged via tests — not applicable, nothing changed yet
- [ ] Tested (unit/integration as applicable) — not applicable
- [ ] Code review passed — pending
- [x] Related tests passing — existing 23/23 tests pass unmodified (`cargo test -p bluecollar-reputation`)

## Files Affected
None. This is a findings document only.
