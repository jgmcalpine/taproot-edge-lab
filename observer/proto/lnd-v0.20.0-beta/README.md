# Pinned LND protocol definitions

Unmodified files from **v0.20.0-beta**, commit
`b9ea7070c20ad2ca8514a47d9b4d560a501f0487`, of
[lightningnetwork/lnd](https://github.com/lightningnetwork/lnd/tree/v0.20.0-beta).

- `lnrpc/routerrpc/router.proto`: Router service and HTLC messages.
- `lnrpc/lightning.proto`: its only import, including failure codes.
- `LICENSE`: upstream MIT license and copyright attribution.

Only these two required proto files are vendored. They are kept whole to avoid
maintaining a hand-transcribed wire schema; the observer calls only
`/routerrpc.Router/SubscribeHtlcEvents`. No generated SDK or build step is needed.
Use the pinned commit when re-fetching, never master.

SHA-256 checksums:

```text
8de51253eaa478175ab21be522862cfa33c07d9dc390d7aa4544bf4220ac4f3a  lightning.proto
34f97ce4ea33fcca3f92838860a2b0ba79f071193e9024142f2ac4832e99383c  routerrpc/router.proto
```

Verified implementation behavior at this tag:

- `lnrpc/routerrpc/router_server.go`, `SubscribeHtlcEvents`: registers the
  notifier, then sends `subscribed_event` before forwarding notifications.
- `lnrpc/routerrpc/subscribe_events.go`, `rpcHtlcEvent`: FINAL uses only the
  incoming circuit and leaves `event_type` UNKNOWN. SETTLE has a preimage but
  no amounts. `htlcswitch/htlcnotifier.go` documents forwarding payloads for
  local sends/forwards and settlement payloads for receives/sends/forwards;
  an amount-bearing RECEIVE payload is not promised.
- The HtlcEvent comment explicitly states best-effort, non-persisted delivery,
  potential losses on crashes and possible replay after restart.

The application uses circuit IDs for lifecycle correlation, not lifecycle
deduplication. Only identical decoded messages (including timestamp and payload)
are collapsed in normalized output; every raw occurrence is retained.
