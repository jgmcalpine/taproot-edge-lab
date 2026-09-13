export type NodeName = "bob" | "carol" | "alice";
export type Json = Record<string, unknown>;

// RPC uint64 values remain decimal strings. SCIDs exceed Number.MAX_SAFE_INTEGER.
export type TraceEvent = {
  timestamp?: string;
  relativeMs?: number;
  node: NodeName | "system";
  layer: "bitcoin" | "lightning" | "taproot-assets" | "rfq" | "observer";
  type: string;
  observed: boolean;
  paymentHash?: string;
  paymentPreimage?: string;
  rfqId?: string;
  assetId?: string;
  assetAmount?: string;
  amountMsat?: string;
  incomingChannelId?: string;
  outgoingChannelId?: string;
  htlcId?: string;
  attemptId?: string;
  source: string;
  details?: Json;
};

export type Channel = {
  node: NodeName;
  remotePubkey?: string;
  channelPoint?: string;
  channelId?: string;
  scid?: string;
  routingIds: string[];
  active: boolean;
  commitmentType?: string;
  btcLocalSat?: string;
  btcRemoteSat?: string;
  assetId?: string;
  assetLocal?: string;
  assetRemote?: string;
  assetFunding?: string;
  btcUnsettledSat?: string;
  pendingHtlcs?: { paymentHash?: string; htlcId?: string; incoming?: boolean; amountSat?: string }[];
  assetIncomingHtlcUnits?: string;
  assetOutgoingHtlcUnits?: string;
};

export type Snapshot = {
  rawSuffix?: string;
  startedAt: string;
  endedAt: string;
  nodes: Partial<Record<NodeName, { info?: Json; channels?: Channel[] }>>;
  bobAssetBalances?: Json;
  bobQuotes?: Json;
  aliceInvoice?: Json;
  errors: string[];
};

export type Delta = {
  node: NodeName;
  channelPoint: string;
  assetId?: string;
  btcLocalSat?: string;
  btcRemoteSat?: string;
  assetLocal?: string;
  assetRemote?: string;
};

export type Config = {
  assetName: string;
  assetId: string;
  carolPubkey: string;
  containers: Partial<Record<NodeName | "backend1", string>>;
  users: Record<NodeName, string>;
  lncliArgs: Record<NodeName, string[]>;
  litcliArgs: string[];
  tapcliArgs: string[];
  feeLimitSat: number;
  paymentTimeoutSeconds: number;
};
