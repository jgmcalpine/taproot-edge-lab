The [payment observer guide](observer/README.md) explains how to run
`pnpm trace:payment` against the existing Polar/regtest LabUSD → BTC lab,
inspect the captured evidence, and run the offline tests.

Milestone 02 adds live LND v0.20.0 HTLC switch tracing on Bob, Carol and Alice.
The trace links Carol's actual forwarding messages to the LabUSD economic
evidence and Alice's ordinary BTC invoice. See
[Live HTLC switch tracing](observer/README.md#live-htlc-switch-tracing) for
readiness, credentials, replay handling and the stream's best-effort limits.
