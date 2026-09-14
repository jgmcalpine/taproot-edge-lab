# Payment observer

**How does Bob pay Alice's ordinary BTC invoice using LabUSD, and what can we
actually prove happened at Carol's asset edge?** This tracer answers that
question for one payment in an existing Polar/regtest lab.

```text
Bob (litd + embedded LND/tapd)      Carol (litd + embedded LND/tapd)      Alice (LND)
             -- LabUSD overlay -->             -- BTC Lightning -->
             SIMPLE_TAPROOT_OVERLAY             ordinary BTC channel
```

Alice intentionally runs plain LND. Her invoice and received HTLC provide the
BTC-native endpoint against which we compare Bob's asset-side payment. There is
no UI, service, database, market maker, hedging system or channel provisioning.

## Requirements

The existing channels must already be active, wallets synced to Bitcoin
regtest, Bob's asset channel funded with the configured asset, and Carol's
BTC channel funded toward Alice. Each LND gRPC port must be published to the
host, with readable TLS and macaroon files inside its container. Run one trace at a time in an otherwise quiet
lab; concurrent payments make balance attribution ambiguous.

| Component | Verified environment |
| --- | --- |
| Host | Node.js 24.18.0; Node 24+ required for native TypeScript execution |
| Package manager | pnpm 11.9.0, pinned in the root package.json |
| Polar containers | Running Docker containers with docker exec access |
| Bob and Carol | litd 0.16.0-alpha, embedded LND 0.20.0-beta, tapd 0.7.0-alpha |
| Alice | Plain LND 0.20.0-beta |
| backend1 | Bitcoin Core 30.0, regtest |

Docker is the only host-side lab CLI required. `lncli`, `litcli` and `tapcli`
run inside their containers. Bitcoin Core is discovered but never invoked: the
tracer does not mine, mint, open channels, change daemon settings or repair
anything. Apart from invoice creation and the single payment attempt, commands
query the existing environment. The asset decoder queries the configured price
oracle; the payment negotiates an RFQ with Carol.

## Run

From the repository root:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm trace:payment
```

The default creates a new **1,000 sat** Alice invoice with memo
`Taproot Edge Lab trace`, then invokes Bob's `litcli ln payinvoice` once.

```bash
pnpm trace:payment --amount-sat 2000
pnpm trace:payment --invoice='<ALICE_REGTEST_BOLT11>'
pnpm trace:payment --config observer/lab.local.json --out traces
pnpm trace:payment --htlc-grace-ms 1000
pnpm trace:payment --help
```

`--amount-sat` and `--invoice` are mutually exclusive. An explicit invoice must
be a positive whole-satoshi, unexpired, unblinded, non-AMP regtest BOLT11 invoice
owned by configured Alice and still `OPEN`. The tracer checks her invoice DB;
it will not pay an arbitrary external invoice or reuse a settled one.

Preflight checks Docker, all four running containers, each node's identity and
regtest sync, both endpoints of the active channels, and Bob's known channel-side
asset balance. It rejects ambiguous parallel channels and pending target-channel
HTLCs. It captures CLI help/version information and requires all three live HTLC
subscriptions to acknowledge readiness before creating an invoice. Invoice and
asset-liquidity checks then complete before the payment command is invoked.

Before paying, `decodeassetinvoice` gives an asset-unit estimate. The conservative
liquidity screen is:

```text
ceil(estimated invoice asset units × (invoice msat + fee-limit msat) / invoice msat) + 1
```

The final `+1` allows integer rounding. This includes the full fee allowance and
can reject a balance that would cover a cheaper actual payment. It is an
estimate, **not a binding Carol quote**; rates, channel reserves and concurrent
HTLCs can still cause payment failure. Wallet-held assets do not count as channel
liquidity. Carol's local BTC balance must also cover the invoice amount.

Default payment flags include `--fee_limit=500`, `--timeout=60s`, `--force`,
`--json`, and `--inflight_updates`. The selected Bob channel's SCID is passed as
`--outgoing_chan_id`, Carol as `--last_hop` and `--rfq_peer_pubkey`, and
`--max_parts=1` keeps the experiment to one part. LND may still report multiple
attempts; every update is retained. No expected asset delta is hardcoded.

## Configuration

[lab.config.json](lab.config.json) is the single configuration layer. It contains
the known LabUSD asset ID, Carol pubkey, Docker users, CLI connection arguments,
fee limit, payment timeout and the `htlc` settings below. Asset genesis metadata is discovered in captured
responses; it is not duplicated in command code.

Containers default to discovery of one `polar-n<number>-bob`, `-carol`, `-alice`
and `-backend1`. The network number is not fixed. Multiple candidates or mixed
Polar network numbers fail clearly. For renamed nodes or multiple networks:

```bash
export LAB_BOB_CONTAINER=polar-n2-bob
export LAB_CAROL_CONTAINER=polar-n2-carol
export LAB_ALICE_CONTAINER=polar-n2-alice
export LAB_BACKEND1_CONTAINER=polar-n2-backend1
pnpm trace:payment
```

| Environment variable | Overrides |
| --- | --- |
| `LAB_BOB_CONTAINER`, `LAB_CAROL_CONTAINER`, `LAB_ALICE_CONTAINER`, `LAB_BACKEND1_CONTAINER` | Individual container names |
| `LAB_ASSET_ID` | 32-byte asset ID in hex |
| `LAB_CAROL_PUBKEY` | Compressed Carol pubkey in hex, verified against getinfo |

For other paths or endpoints, copy the complete configuration:

```bash
cp observer/lab.config.json observer/lab.local.json
pnpm trace:payment --config observer/lab.local.json
```

The local file is ignored by Git. Environment values override file values.
`lncliArgs` can set each node's RPC/TLS/macaroon paths; `litcliArgs` and
`tapcliArgs` apply to Bob. Use `--flag=value` strings. Execution uses argument
arrays and never a shell. The network is fixed to regtest.

In this Polar integrated setup, these credentials are **different**:

| Client | Docker user / endpoint | Authentication |
| --- | --- | --- |
| Bob/Carol lncli | `litd`; localhost:10009 | User's `.lnd` defaults |
| Alice lncli | `lnd`; localhost:10009 | User's `.lnd` defaults |
| Bob litcli | `litd`; localhost:8443 | `/home/litd/.lit/regtest/lit.macaroon` |
| Bob tapcli | `litd`; localhost:8443 | `/home/litd/.tapd/data/regtest/admin.macaroon` |

Both 8443 CLI clients use `/home/litd/.lit/tls.cert` and receive credential
paths as arguments. The direct HTLC adapter instead reads the LND certificate
and binary admin macaroon into memory using non-recording `docker exec cat`
calls. It never writes credential files or prints macaroon values. The macaroon
is hex-encoded only in gRPC metadata; credential subprocess stdout/stderr and
arbitrary gRPC error details are excluded from trace serialization.

| HTLC setting | Default / meaning |
| --- | --- |
| `containerPort` | `10009`; Docker inspect discovers its published host port for each resolved container |
| `tlsCertPaths.bob`, `.carol` | `/home/litd/.lnd/tls.cert` |
| `tlsCertPaths.alice` | `/home/lnd/.lnd/tls.cert` |
| `macaroonPaths.bob`, `.carol` | `/home/litd/.lnd/data/chain/bitcoin/regtest/admin.macaroon` |
| `macaroonPaths.alice` | `/home/lnd/.lnd/data/chain/bitcoin/regtest/admin.macaroon` |
| `readinessTimeoutMs` | `10000` per node, including connection setup; configurable 100–60000 ms |
| `settlementGraceMs` | `1000`; configurable 0–5000 ms, also overridden by `--htlc-grace-ms` |

The adapter connects to loopback at the discovered port, verifies TLS using the
node certificate, and selects a TLS name only after checking its SAN against the
Docker hostname, container name or localhost. This is a verified target-name
override, not disabled certificate verification. Ambiguous/unpublished ports
fail. Neither the current Polar network prefix nor host port numbers are fixed
in source code. Older Milestone 01 configuration files inherit the central HTLC
defaults; custom CLI credential paths do not automatically override `htlc` paths.

## Live HTLC switch tracing

Milestone 02 adds a direct TypeScript client for the server-streaming
`routerrpc.Router.SubscribeHtlcEvents` RPC on Bob, Carol and Alice. It exposes
what LND's HTLC switch reports while Bob's asset payment crosses Carol's edge.
The existing CLI payment, RFQ, invoice and balance captures remain separate.

The adapter uses `@grpc/grpc-js` and `@grpc/proto-loader`, with the unmodified
[LND v0.20.0-beta definitions and license](proto/lnd-v0.20.0-beta/README.md).
Only `router.proto` and its `lightning.proto` import are needed. Preflight rejects
other LND versions until their API is explicitly verified. The v0.20 server
registers its notifier before emitting `subscribed_event`, so the tracer uses
that message, rather than TCP connectivity or response headers, as readiness.

```text
BEFORE snapshots + topology/version checks
  → subscribe Bob, Carol, Alice
  → all three subscribed_event messages received
  → create/validate Alice invoice + check asset liquidity
  → execute Bob payment once, preserving all inflight updates
  → bounded settlement grace period
  → cancel streams and close gRPC clients
  → AFTER snapshots, normalization/correlation and summary
```

A failed or timed-out subscription aborts before payment. The tracer checks
health again immediately before dispatch, including failures during invoice
preparation. A stream failure during payment marks the evidence incomplete;
it cannot undo an already-dispatched payment. No reconnect/retry conceals that
gap. Normal observer-initiated cancellation is expected teardown. All raw
messages already captured and node/status diagnostics are retained on failure.
After the payment command finishes, a single configurable grace period lets
settle/final messages in flight arrive; the default is 1 second. This also runs
on non-terminal client failure, without asserting that the daemon has stopped.
User interruption cancels immediately instead of delaying teardown.

### Role and lifecycle are different

`event_type` describes the node's role: SEND originates here, RECEIVE terminates
here, and FORWARD crosses from an incoming to an outgoing channel. The oneof
payload describes a lifecycle notification:

| Payload | Fields / interpretation |
| --- | --- |
| `forward_event` | Optional `info` with incoming/outgoing amounts in msat and timelocks; used for local SEND and FORWARD |
| `settle_event` | Revealed preimage, without amounts; the role still says SEND, RECEIVE or FORWARD |
| `forward_fail_event` | Downstream forwarding failure; empty payload in this version |
| `link_fail_event` | HTLC info, wire failure, failure detail and failure string |
| `final_htlc_event` | `settled` and `offchain`; v0.20 exposes only the incoming circuit and leaves role UNKNOWN |
| `subscribed_event` | Readiness acknowledgment, with no meaningful HTLC/time fields |

A successful Alice receive may therefore appear as `RECEIVE / settle_event`,
without an amount-bearing `forward_event`. No row or amount is manufactured to
fill that gap. SETTLE and FINAL normalized events never inherit amounts from a
previous forward. Alice's amount, `custom_records: {}` and
`custom_channel_data: ""` are separately observed by LookupInvoice, whose raw
filename appears in the summary.

Carol's FORWARD is the centerpiece: a single message can connect the incoming
asset-overlay channel to the outgoing BTC channel and expose both msat amounts.
These are direct switch observations. The LabUSD denomination comes from Bob's
RFQ/route custom data and the asset balance changes; joining those observations
is a **correlated conclusion**, not an additional field observed by Carol's RPC.
The first-hop carrier/anchor sats are not the payment's economic asset value.

### Circuit correlation and replay

`node + incoming channel/HTLC IDs + outgoing channel/HTLC IDs` identify a local
lifecycle. Distinct FORWARD, SETTLE and FINAL messages are preserved. A FINAL
incoming pair links to a full local circuit only when unambiguous. Across peers,
links require the captured channel point, directed peer identities and the
outgoing/incoming HTLC index. Routing aliases resolve through BEFORE channels;
Bob's payment attempt ID is never assumed to be a wire HTLC index.

A settle preimage whose SHA-256 matches the payment hash, or Alice's exact
invoice channel/HTLC pair, anchors a circuit to this payment. The component
observations stay unchanged (`observed: true`); constructed links live under
`correlation.json.htlc`, including the evidence references used. Unlinked
background events remain in the timeline, labeled unlinked. Nearby timestamps
or similar amounts alone never establish payment identity.

Normalized replay suppression uses a stable SHA-256 fingerprint of the node
and complete decoded event, including circuit IDs, role, payload variant,
`timestamp_ns` and payload fields. Object key order and observer arrival time
are excluded. Only identical messages are collapsed; a changed timestamp or
payload is retained. Every occurrence remains in the raw stream, and
`htlc-streams.json.duplicates` maps duplicate raw lines to their first occurrence.
Deduplication applies within one observation run, not across a persistent store.

### Best-effort evidence and timestamps

LND explicitly documents this as an experimental observability stream:
**events are best-effort, are not persisted, delivery is not guaranteed across
failures/crashes, and some events may be replayed after restart. Raw capture is
evidence from one observation run, not an authoritative accounting database.**
Even a clean subscription and grace period cannot prove no messages were lost.

Each `raw/htlc-<node>.ndjson` record contains `observer_receive_timestamp`, `node`
and the full decoded RPC `event`. LND's `timestamp_ns` remains a separate decimal
string. Protobuf uint64s decode as strings, enums as names, bytes as base64 and
absent proto3 scalars as their defaults; the oneof name is retained as `event`.
This is the decoded RPC representation, not a binary packet capture.

Normalized events set `source: "SubscribeHtlcEvents"` and `evidenceRefs` to exact
`raw/file:line` locations. They retain both clocks, prefer a nonzero valid daemon
nanosecond timestamp, and otherwise use the observer time (notably readiness).
`events.ndjson` is sorted at completion by that selected time. Daemon clocks,
transport buffering and observer scheduling differ across processes; the
millisecond ISO/display timestamps and fractional `relativeMs` do not establish
nanosecond causal ordering across nodes. Original nanoseconds remain exact.
CLI snapshot events retain observer time because embedded attempt/resolve times
refer to past lifecycle changes rather than snapshot arrival.

## Outputs

Each invocation with valid arguments/config creates a unique local directory:

```text
traces/<UTC timestamp>-<random run ID>/
  manifest.json
  commands.ndjson
  before.json
  preflight.json
  after.json
  after-0.json
  after-1.json                 # only if another sample was needed
  payment.jsonl
  events.ndjson
  correlation.json
  htlc-streams.json
  deltas.json
  summary.md
  raw/
    htlc-bob.ndjson
    htlc-carol.ndjson
    htlc-alice.ndjson
    docker-ps.jsonl
    bob-info-before.json
    bob-channels-before.json
    bob-assets-before.json
    bob-quotes-before.json
    carol-channels-before.json
    alice-channels-before.json
    alice-invoice-created.json
    alice-invoice-decoded.json
    alice-invoice-before.json
    bob-asset-estimate.json
    bob-payment.jsonl
    ... corresponding AFTER queries, CLI help/version, and stderr files
```

| File | How to use it |
| --- | --- |
| `manifest.json` | Resolved config, container images, run outcome, payment hash, errors/warnings, last AFTER sample and observation limits |
| `commands.ndjson` | One command per line: node, category, exact argv, start/end times, exit code, signal, timeout/spawn error and stdout/stderr filenames |
| `before.json` | Node getinfo, normalized channels, Bob asset-wallet balance and accepted-quote responses, plus Alice's OPEN invoice |
| `preflight.json` | Decoded amount/hash, selected channels and conservative liquidity estimate; absent if preflight did not finish |
| `after.json` | Final captured snapshot used for deltas; `rawSuffix` identifies its raw files |
| `after-0.json`, `after-1.json`, … | Every AFTER sample, including any pending settlement; raw files are never overwritten |
| `raw/bob-payment.jsonl` | **Byte-preserved litcli stdout**, including the text RFQ line and every pretty-printed JSON update; despite its name this is not valid JSONL |
| `payment.jsonl` | Actual payment JSON objects, one per line, including every IN_FLIGHT update; the text quote lives in raw output and normalized RFQ events |
| `events.ndjson` | Merged CLI/switch timeline with source/line pointers, selected timestamp, observer receive time, node/layer and `observed` flag |
| `raw/htlc-*.ndjson` | Full decoded HTLC messages plus node and observer receive timestamp, including raw replays |
| `htlc-streams.json` | Connection/readiness/cancellation or sanitized failure diagnostics, grace period and duplicate raw-line references; created when subscriptions were started |
| `correlation.json` | Hash/preimage comparisons, SHA-256 check, RFQ/quote links, route SCID-to-channel-point mapping, Alice HTLC IDs and custom-field checks; `htlc` contains switch lifecycle links and per-node preimage comparisons |
| `deltas.json` | Exact signed channel balance changes, AFTER minus BEFORE, per node/channel point |
| `summary.md` | Start here: result, invoice, RFQ, route, economic/carrier/forwarded/received amounts, switch timeline, boundary view, settlement, deltas and evidence limits |
| `raw/*` | Complete CLI stdout responses; every command also has a `.stderr.txt` sidecar, even if empty |

Getinfo and listchannels are captured for all three nodes both before and after.
The Bob asset balance query includes all script-key types, but is not substituted
for channel asset balances. Snapshot start/end and individual command times show
the observation window; parallel queries do not make the snapshot atomic.

The first AFTER sample can lag Bob's terminal success. The observer checks pending
HTLCs, asset HTLC balances and mirrored peer balances. If needed, it takes up to
three further read-only samples, 500 ms apart. Final `after.json` points to the
last sample; the first sample's raw suffix is `after`, then `after-1`, etc.
Failure to converge is reported as incomplete evidence, never silently turned
into an expected balance. This handles the settlement lag observed during the
first live validation.

`traces/` is ignored by Git. Raw responses deliberately include regtest payment
preimages and node/channel metadata so another engineer can verify them. New
trace directories are private to the local user. Review/redact traces before
publishing; the committed test fixtures use replacement credentials/identifiers
and deliberately non-payable invoice strings. No macaroon material is stored.

## How to read a trace

1. **Invoice.** Compare Alice's creation/decoded/OPEN responses. Check the
   destination and requested msat, then retain its hash as the primary key.
2. **RFQ.** Read the first text line of `raw/bob-payment.jsonl`. litcli 0.16 prints
   `Got quote for … asset units at … msat/unit from peer … with SCID …`, even
   with `--json`. Its invoice-only units and integer-displayed rate are observed,
   not a calculation invented by the tracer. Match the quote SCID **and peer**
   to an accepted sell quote; match that quote's full ID to Bob's route RFQ ID.
   Unrelated or expired quotes are not attached based on time proximity.
3. **Asset first hop.** In each payment attempt inspect
   `route.custom_channel_data.balances`, `rfq_id` and
   `route.first_hop_amount_msat`. The successful attempt's balances contain the
   economic asset units; the carrier field contains BTC msat. Repeated attempt
   snapshots do not represent repeated asset movements.
4. **Carol's edge.** Bob's successful route has Carol's pubkey first and Alice's
   second. Match routing SCIDs to listchannels `scid`/aliases and channel points.
   The installed integrated LND's `chan_id` is a long hex channel identifier;
   it is **not** the numeric routing SCID. Quote SCIDs are another namespace.
   Carol's increasing asset balance and decreasing outbound BTC balance support
   the conversion interpretation. Now inspect `raw/htlc-carol.ndjson` for her
   actual FORWARD payload: both channel/HTLC pairs and any incoming/outgoing msat
   are observed in one message. The RPC does not expose the LabUSD RFQ itself.
5. **BTC second hop.** Inspect the ordinary Carol–Alice channel and Alice's
   settled invoice HTLC. Check `amt_msat`, `state`, `custom_records` and
   `custom_channel_data`. Explicitly empty fields establish what Alice's API
   exposed; missing fields do not count as empty.
6. **Settlement.** `correlation.json` checks Bob payment hash == Alice invoice
   hash, Bob final preimage == Alice invoice preimage, and SHA-256(preimage) ==
   payment hash. Route attempts retain attempt IDs; Alice's invoice retains its
   channel/HTLC-index pair. These IDs are scoped: Bob's attempt ID is not Alice's
   HTLC index. A pending channel HTLC is attached only through its exact hash.
   The `htlc` section compares exposed switch settlement preimages at each node
   with both endpoints and checks their SHA-256. An absent preimage stays unknown.
7. **Balances.** Read deltas from each node's local perspective. Bob's asset
   decrease should mirror Carol's asset increase in a quiet settled run. Alice's
   BTC local increase should mirror Carol's BTC remote increase. Funding asset
   amount is channel backing, not the transfer amount.

### Asset economics versus the satoshi carrier

The live validation on 2026-09-13 captured:

| Quantity | Observed |
| --- | --- |
| Invoice amount / Alice received | 1,000 sats / 1,000,000 msat |
| RFQ line's invoice units and displayed rate | 1,000 units at 1,000 msat/unit |
| Accepted quote's asset allowance | 1,500 units, including the fee budget |
| Bob asset local change / Carol asset local change | −1,001 / +1,001 LabUSD units |
| First-hop carrier | 354 sats / 354,000 msat |
| Bob payment fee | 1,001 msat = **1.001 sats** |

These are measurements from that run, not constants or promised future results.
The sat-denominated fee field truncates precision; the summary uses msat.

Taproot Asset HTLCs still need a satoshi-denominated carrier/anchor at the LND
channel layer. Asset units live in the overlay/custom channel data. Thus the
354 sat carrier is neither the LabUSD economic amount nor the 1,000 sats Alice
receives. Do not label it as the payment's economic value or treat the gap as a
routing fee. The run also shows the carrier's BTC movement on the asset channel;
it does not disappear merely because the payment is asset-denominated.

The accepted quote allowance and actual asset debit also differ. The quote
covers a budget, while the final route and settled balance changes show the
actual units used. The raw rate `{coefficient: "100000000", scale: 0}` is an
asset-units-per-BTC fixed-point rate, **not** 100,000,000 msat/unit. The tracer
retains it as raw structured data and separately records litcli's displayed
msat/unit rate. It does not impose a USD price or asset decimal convention.

## Milestone 02 live validation — 2026-09-14

`pnpm trace:payment --amount-sat 1000` succeeded at height 114 in trace
`2026-09-14T15-38-55Z-e5f404a0`. The first attempt stopped before invoice creation
because the idle lab's height-113 tip was stale and all three nodes reported
unsynced. One separately approved regtest block refreshed the tip; no mining or
sync bypass was added to the tracer.

| Direct observation | Actual result | Evidence in that trace |
| --- | --- | --- |
| Bob SEND / forward_event | Outgoing 354,000 msat, Bob–Carol HTLC 3 | `raw/htlc-bob.ndjson:2` |
| Carol FORWARD / forward_event | Incoming **1,002,000 msat**, outgoing **1,000,000 msat**; Bob–Carol HTLC 3 → Carol–Alice HTLC 4 | `raw/htlc-carol.ndjson:2` |
| Alice RECEIVE / settle_event | Preimage and incoming HTLC 4; **no amount field** | `raw/htlc-alice.ndjson:2` |
| Alice LookupInvoice | Paid 1,000,000 msat; settled HTLC 4 with empty custom records/data | `raw/alice-invoice-after.json` |
| Bob successful asset route | 1,001 LabUSD units; carrier 354,000 msat; fee 1,001 msat | `payment.jsonl:3` |
| Asset balance arithmetic | Bob −1,001 / Carol +1,001 units | `deltas.json`, BEFORE/AFTER channels |

The expected **354,000 → 1,000,000 msat inside Carol's FORWARD** was **not**
observed. Her incoming field is already different from Bob's carrier. The
summary calls out that discrepancy explicitly and preserves both values.

Source-based explanation, distinct from a captured interceptor event:
[tapd v0.7 AssetPurchasePolicy.GenerateInterceptorResponse](https://github.com/lightninglabs/taproot-assets/blob/v0.7.0/rfq/order.go#L510-L537)
adds one asset unit for rounding, converts at the accepted bid rate, and supplies
a modified incoming amount for LND fee validation.
[LND v0.20 ResumeModified](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/htlcswitch/interceptable_switch.go#L669-L708)
updates the packet's incoming amount, which
[the outgoing link's notifier](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/htlcswitch/link.go#L1658-L1669)
then reports. Here, 1,001 asset units plus one rounding unit at the captured rate
is consistent with 1,002,000 msat. That extra unit is a validation allowance, not
an additional measured asset debit, and the 2,000-msat switch difference is not
Bob's observed 1,001-msat payment fee. The interceptor exchange itself was not
captured; no such raw event is claimed.

All three streams exposed the same settlement preimage as Bob's final payment
and Alice's invoice, and its SHA-256 matched the payment hash. Carol and Alice
emitted FINAL with `settled: true`, `offchain: true`, UNKNOWN role and incoming-only
IDs. Bob emitted no FINAL. Alice emitted no amount-bearing forward payload.
These omissions are retained as observations, not filled from other sources.

The run captured ten raw RPC messages: three readiness acknowledgments and
seven lifecycle messages. All subscriptions were ready before invoice creation;
all were canceled cleanly after the 1,000-ms grace period. There were no detected
stream failures or duplicate messages, and the first AFTER sample was settled.
This does not upgrade LND's best-effort delivery guarantee. Sanitized copies of
all ten records are committed in [live-htlc.ndjson](test/fixtures/live-htlc.ndjson).

Final verification passed 49 offline tests (including all 26 Milestone 01 tests),
typechecking, and a frozen-lockfile install/typecheck in a temporary clean copy
without node_modules. An in-memory audit checked all five LND/LiT/tapd macaroons
against the trace in binary, hex and base64 forms and found no matches. Each
normalized switch record was also compared back to its exact raw RPC record.

## Observed versus inferred

Emitted events keep `observed: true` for actual response fields or observer
actions. Live SEND/FORWARD/SETTLE records now have exact raw RPC references.
The schema version is 2; existing CLI event types and sources remain compatible.
Cross-source payment/circuit links live in the correlation artifact rather than
being presented as directly observed payment hashes on HTLC messages.
`INVOICE_HTLC_SNAPSHOT` can contain a settled HTLC; it was learned by querying
the invoice after payment, not by witnessing a live RECEIVE event.

For CLI snapshots, `timestamp` and `relativeMs` mark observer handling. HTLC
events prefer daemon timestamps as described above. CLI attempt/resolve times
remain in `details` with their original units. Snapshot
sources identify the observation interval. No ordering or correlation relies
solely on nearby timestamps. Payment/quote IDs and SCIDs are strings to avoid
JavaScript integer rounding; numeric balances use BigInt arithmetic and serialize
as decimal strings. Unknown/unrecognized custom data remains raw and missing
normalized values stay unknown.

The summary labels protocol interpretation **INFERRED**. Empty Alice HTLC custom
fields and absent RFQ IDs demonstrate what the captured API response contains;
they do not prove facts about every byte of Alice's internal state. Alice's
plain-LND role comes from the configured lab and captured version/image evidence.

## Failures and observability limits

- The installed LND 0.20 `lncli --help` on Bob, Carol and Alice exposes no
  `SubscribeHtlcEvents` command. The direct Router gRPC adapter supplies that
  observability; CLI help output remains saved per run. The stream is best-effort
  and incomplete coverage causes an error without undoing a successful payment.
- tapd 0.7 `tapcli events` offers asset send/receive/mint subscriptions, not a
  replacement for LND's HTLC event stream. Its `rfq acceptedquotes` is a snapshot;
  absence or failure leaves quote linkage unestablished and produces a warning.
- litd 0.16 mixes text RFQs with JSON objects and reports repeated attempt states.
  New versions may change the schema. Unsupported fields are preserved raw;
  do not interpret “not observed” as zero or absence.
- The tracer checks the one known two-channel topology, forces a single payment
  part, and does not support blinded routes, arbitrary recipients or multiple
  edge nodes. This is not a general-purpose Lightning SDK.
- Queries are bounded at 20 seconds; the payment client gets the configured
  daemon timeout plus 30 seconds. SIGINT/SIGTERM stops the client and attempts
  read-only AFTER capture. Killing a Docker exec client may leave its remote
  command/RPC running; it is not proof of payment cancellation.
- Exit **0** means a streamed SUCCEEDED result with complete required snapshots,
  matching settlement evidence, the recognized asset route/RFQ/carrier and Alice's
  explicitly empty settled HTLC custom fields, all three payment-correlated switch
  roles and amount-bearing Bob SEND / Carol FORWARD payloads. Alice's switch amount need not be present.
  Exit **1** includes NOT_ATTEMPTED, FAILED,
  UNKNOWN or successful payment with incomplete evidence. Optional RFQ snapshot
  warnings are recorded separately. Config/argument errors can fail before a
  trace directory exists.
- Failed preflight after invoice creation can leave an OPEN invoice. The tracer
  does not cancel it. On UNKNOWN or interruption, inspect the saved payment hash
  before starting another run; a new default run creates a different invoice.

Example read-only check after an interrupted run (adjust names/users from config):

```bash
docker exec --user lnd polar-n1-alice lncli --network=regtest \
  lookupinvoice --rhash='<HASH_FROM_MANIFEST>'
docker exec --user litd polar-n1-bob lncli --network=regtest \
  trackpayment '<HASH_FROM_MANIFEST>'
```

The next useful happy-path experiment is a second invoice amount with unchanged
pricing, comparing the observed carrier, Carol's outgoing msat and the actual
asset debit. This tests how those quantities scale without treating one run's
measurements as constants. It is not run automatically.

## Troubleshooting this lab

| Symptom | Check |
| --- | --- |
| Docker unavailable / socket permission denied | Start Docker Desktop; check `docker ps` works as the user running pnpm. A sandbox may require Docker access. The tracer does not restart Docker. |
| Container missing, ambiguous or names changed | Start the intended Polar network; inspect `docker ps --format '{{.Names}}'`; set the four `LAB_*_CONTAINER` overrides. |
| `channels cannot be created before wallet fully synced` | This is a setup error, not something the observer fixes. Check each node's `getinfo.synced_to_chain` and the Polar backend. The tracer refuses unsynced nodes and never opens channels or mines blocks. |
| All nodes match Core height but report unsynced after the lab was idle | Inspect the best-header timestamp. A stale regtest tip can require a fresh block through Polar; this is separate lab maintenance, never an automatic tracer action. |
| HTLC readiness timeout, TLS or gRPC authentication error | Inspect `htlc-streams.json`, the mapped LND port and configured LND credential paths. No invoice/payment starts before readiness. The adapter uses LND credentials, not LiT credentials. |
| `/root/.lnd/tls.cert` missing | Docker exec defaults to root. Use `--user litd` for Bob/Carol and `--user lnd` for Alice, as configured. |
| `litcli` macaroon signature mismatch | Check Bob's LiT macaroon path, network and TLS endpoint. Use the LiT macaroon for litcli, not the LND or tapd admin macaroon. |
| `tapcli` signature mismatch on port 8443 | Integrated tapd requires its own `/home/litd/.tapd/data/regtest/admin.macaroon`, even though it shares LiT's port/TLS certificate. Using the LiT macaroon for tapd reproduced this error in this lab. |
| Plain `tapcli` dials localhost:10029 | In this integrated container use localhost:8443 with LiT TLS and tapd admin macaroon, as in config. Standalone tapd defaults do not apply. |
| Asset appears in wallet but liquidity check fails | Inspect Bob's target channel `custom_channel_data.local_assets`; wallet balance is separate. Confirm the asset ID and fee allowance. No assets are moved automatically to repair liquidity. |
| SUCCEEDED but Carol asset local delta initially zero | Inspect pending HTLCs and the earlier AFTER samples. The bounded recheck waits for settlement visibility; a sample limit produces incomplete evidence rather than a fabricated delta. |
| Unexpected schema / JSON parsing failure | Read the command's stdout, stderr and CLI versions. Raw payment stdout includes a text quote; use payment.jsonl for a strict JSONL reader. |

Errors identify node, command category and raw evidence file. Stderr is preserved
locally instead of being dumped indiscriminately into the terminal.

## Code and tests

The only runtime npm dependencies are `@grpc/grpc-js` and `@grpc/proto-loader`.
Node executes erasable TypeScript directly; TypeScript and Node types remain
development dependencies. The lockfile pins the dependency tree.
`pnpm-workspace.yaml` explicitly skips protobufjs's optional version-warning
postinstall script; protobuf decoding needs no build step. Offline TLS tests
use OpenSSL and a short-lived local gRPC server, with generated test credentials.

| Module | Responsibility |
| --- | --- |
| `src/config.ts` | CLI arguments, config validation, Polar discovery |
| `src/command.ts` | Docker subprocess boundary; injectable Executor; raw bytes and command metadata |
| `src/json-stream.ts` | Incremental text/concatenated-JSON framing |
| `src/model.ts`, `src/normalize.ts` | Trace model; pure channel/payment/quote normalization, correlations and deltas |
| `src/preflight.ts` | Identity, topology, invoice and liquidity checks |
| `src/trace.ts` | One run's sequence, streaming capture, bounded AFTER sampling and failure artifacts |
| `src/htlc-source.ts` | Pinned gRPC client, Docker endpoint discovery, memory-only credentials, verified TLS and cancellation |
| `src/htlc-capture.ts` | Three-node readiness/health gate, raw event capture and teardown diagnostics |
| `src/htlc-normalize.ts` | Pure HTLC normalization, fingerprints, channel labels and lifecycle/payment correlation |
| `src/summary.ts`, `src/htlc-summary.ts` | Pure Markdown rendering from separate observed and correlated evidence |
| `src/cli.ts` | Terminal entry point, signals and exit code |

`pnpm test` uses Node's test runner without Polar/Docker. Sanitized actual lab
responses, a captured three-update payment stream and Carol's transient pending
settlement are in [test/fixtures](test/fixtures/README.md). Tests cover framing
across arbitrary chunks, exact large IDs, overlay extraction, missing fields,
deltas, correlation, summary claims, preflight rejection, command output/timeouts
and full orchestration through an injected executor. Constructed test states are
explicitly distinguished from recorded responses. `pnpm trace:payment` itself is
the opt-in live integration check and spends lab assets; ordinary tests never do.

HTLC tests additionally cover pinned binary decoding, all payload variants,
large IDs, missing fields, exact replay versus lifecycle retention, peer/final
circuit links, role labels, summary provenance, readiness failure/timeouts,
stream failure during payment, TLS name verification, clean cancellation and
secret exclusion. They run without Docker/Polar or network services.
The trace model, arithmetic and summary renderer have no Docker dependencies.

## Protocol and version references

- [Lightning Labs: Taproot Assets channels](https://docs.lightning.engineering/lightning-network-tools/taproot-assets/taproot-assets-channels)
  explains integrated channels and satoshi anchoring.
- [litcli 0.16 payment implementation](https://github.com/lightninglabs/lightning-terminal/blob/v0.16.0-alpha/cmd/litcli/ln.go)
  contains `resultStreamWrapper.Recv`, including the text quote and its integer
  msat/unit display. Installed `--help` and live raw output remain the evidence
  for the commands used here.
- [tapd 0.7 RFQ conversion math](https://github.com/lightninglabs/taproot-assets/blob/v0.7.0/rfqmath/convert.go)
  specifies the units-per-BTC rate and satoshi carrier calculations.
- [tapd 0.7 RFQ schema](https://github.com/lightninglabs/taproot-assets/blob/v0.7.0/taprpc/rfqrpc/rfq.proto)
  defines accepted quotes and fixed-point rates.
- [LND 0.20 Router RPC schema](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/lnrpc/routerrpc/router.proto)
  defines the pinned HTLC schema used by this adapter.
- [LND v0.20 server readiness](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/lnrpc/routerrpc/router_server.go)
  implements the initial subscribed event after notifier registration.
- [LND v0.20 HTLC event mapping](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/lnrpc/routerrpc/subscribe_events.go)
  shows the distinction between role and payload, including FINAL/UNKNOWN.
- [LND v0.20 notifier semantics](https://github.com/lightningnetwork/lnd/blob/v0.20.0-beta/htlcswitch/htlcnotifier.go)
  explains best-effort delivery and the event kinds emitted for sends, forwards
  and receives.
