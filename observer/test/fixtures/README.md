# Fixture provenance

`lab.json` contains responses read from the existing Polar regtest lab on
2026-09-13: Bob/Carol/Alice `getinfo` and `listchannels`, Bob's previously
successful `listpayments` entry, and Alice's matching settled `lookupinvoice`.
The observed final payment has 1,001 asset units, a 354,000 msat carrier,
1,000,000 msat delivered, and 1,001 msat in fees.

Payment preimages/hashes, payment addresses, script keys and metadata hashes
were replaced with deterministic test values. The replacement hash is the
SHA-256 of the replacement preimage. BOLT11 strings are deliberately invalid
and cannot be paid. Public lab topology, asset IDs and channel IDs remain so
the fixtures exercise the installed schema, including a 64-character channel
ID distinct from its numeric routing SCID.

`helpers.ts` constructs intermediate IN_FLIGHT updates and hypothetical balance
changes for parser/arithmetic tests. Those constructed states are **not**
claimed to be captured historical stream updates or live before/after evidence.
The injected command executor exercises orchestration without Docker or Polar.

`live-payment.jsonl` is the actual raw litcli stdout from the tracer validation
at 2026-09-13T23:21:57Z, with only hash/preimage, invoice and payment-address
strings replaced. Whitespace, text quote, both IN_FLIGHT updates and the final
SUCCEEDED update are retained. `settlement-samples.json` preserves normalized
Carol channel samples from that same run: first with the asset HTLC pending,
then settled. The pending hash uses the same deterministic replacement as the
stream. These two files are captured regression evidence, unlike the constructed
intermediate updates in `helpers.ts`.

`htlc-events.json` is a **constructed, sanitized** SubscribeHtlcEvents fixture
modeled on the pinned LND v0.20.0-beta proto and `subscribe_events.go` mapping.
It is not a captured historical stream. It covers SEND/FORWARD, RECEIVE with a
SETTLE payload (no amount), partial FINAL/UNKNOWN events, and separate failure
payloads. The preimage is the same deterministic test value as `lab.json`.
Tests round-trip every fixture through the pinned protobuf wire codec. A
hypothetical RECEIVE/forward_event is separately constructed to test that
supported payload without claiming the installed daemon emits it.

`htlc-source.test.ts` creates an ephemeral TLS server and test-only credentials
to verify the actual gRPC/TLS/metadata/cancellation boundary. It needs OpenSSL
(available on the supported host), but no Docker, Polar or internet access.

`live-htlc.ndjson` preserves all ten decoded records from the successful
2026-09-14T15:38:55Z Milestone 02 run, grouped Bob/Carol/Alice. Only settlement
preimages were replaced with the same deterministic value as `lab.json`.
Timestamps, channel/HTLC IDs, roles, payloads and amounts are unchanged. It
captures the important unexpected result: Bob SEND outgoing 354,000 msat,
Carol FORWARD incoming **1,002,000** msat and outgoing 1,000,000 msat. Alice
has RECEIVE/SETTLE without an amount. Bob has no FINAL; Carol and Alice do.
The earlier constructed `htlc-events.json` intentionally retains a different
incoming amount to ensure the implementation does not impose this run's values.
