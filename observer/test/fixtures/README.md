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
