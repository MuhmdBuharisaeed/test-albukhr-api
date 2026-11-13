"use strict";

const assert = require("node:assert/strict");
const createService = require("../testnet-a2u-service");

class FakeSupabase {
  constructor(rows) { this.rows = rows; }
  from(table) { return new FakeQuery(this, table); }
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.patch = null;
  }
  select() { return this; }
  update(patch) { this.patch = patch; return this; }
  eq(key, value) { this.filters.push([key, "eq", value]); return this; }
  is(key, value) { this.filters.push([key, "is", value]); return this; }
  async maybeSingle() {
    const rows = this.db.rows[this.table] || [];
    const row = rows.find((candidate) => this.filters.every(([key, op, value]) => {
      if (op === "eq") return candidate[key] === value;
      return candidate[key] === value;
    }));
    if (!row) return { data: null, error: null };
    if (this.patch) Object.assign(row, this.patch);
    return { data: { ...row }, error: null };
  }
}

const uid = "pi-testnet-owner-uid";
const requestId = "00000000-0000-4000-8000-000000000001";
const rows = {
  withdrawal_requests: [{
    id: requestId, network: "testnet", status: "processing",
    pi_uid: uid, a2u_payment_id: null, txid: null,
  }],
  project_owner_withdrawals: [{
    id: "00000000-0000-4000-8000-000000000002",
    network: "testnet", status: "processing",
    a2u_payment_id: null, txid: null,
  }],
};

let adapterOptions;
const service = createService({
  supabase: new FakeSupabase(rows),
  apiKey: "test-api-key",
  walletPrivateSeed: "test-private-seed",
  appWallet: "G" + "A".repeat(55),
  createPayoutAdapter(options) {
    adapterOptions = options;
    return {
      async submit(row, piUidValue, sourceType) {
        const paymentId = sourceType === "staker_withdrawal" ? "pi-staker-payment" : "pi-owner-payment";
        const txid = sourceType === "staker_withdrawal" ? "PI_STAKER_TX" : "PI_OWNER_TX";
        await options.persistPaymentId({ requestRow: row, sourceType, paymentId });
        await options.persistTxid({ requestRow: row, sourceType, paymentId, txid });
        return { paymentId, txid, piUid: piUidValue };
      },
      async reconcile(row, piUidValue, sourceType) {
        return { paymentId: row.a2u_payment_id, txid: row.txid, piUid: piUidValue, sourceType };
      },
    };
  },
});

(async () => {
  const stakerRow = { ...rows.withdrawal_requests[0], net_amount: 0.5, wallet_address: "G" + "B".repeat(55) };
  const staker = await service.submitStaker(stakerRow);
  assert.equal(staker.piUid, uid);
  assert.equal(rows.withdrawal_requests[0].a2u_payment_id, "pi-staker-payment");
  assert.equal(rows.withdrawal_requests[0].txid, "PI_STAKER_TX");

  // A repeated write of the same payment ID and TXID is idempotent.
  await adapterOptions.persistPaymentId({ requestRow: stakerRow, sourceType: "staker_withdrawal", paymentId: "pi-staker-payment" });
  await adapterOptions.persistTxid({ requestRow: stakerRow, sourceType: "staker_withdrawal", paymentId: "pi-staker-payment", txid: "PI_STAKER_TX" });

  // A different payment or txid cannot overwrite an existing payout.
  await assert.rejects(
    () => adapterOptions.persistPaymentId({ requestRow: stakerRow, sourceType: "staker_withdrawal", paymentId: "pi-other-payment" }),
    /A2U_PAYMENT_ID_PERSIST_CONFLICT/
  );
  await assert.rejects(
    () => adapterOptions.persistTxid({ requestRow: stakerRow, sourceType: "staker_withdrawal", paymentId: "pi-staker-payment", txid: "PI_OTHER_TX" }),
    /A2U_TXID_PERSIST_CONFLICT/
  );

  const ownerRow = { ...rows.project_owner_withdrawals[0], requested_amount: 1.75, wallet_address: "G" + "C".repeat(55) };
  const owner = await service.submitOwner(ownerRow, "pi-owner-uid");
  assert.equal(owner.piUid, "pi-owner-uid");
  assert.equal(rows.project_owner_withdrawals[0].a2u_payment_id, "pi-owner-payment");
  assert.equal(rows.project_owner_withdrawals[0].txid, "PI_OWNER_TX");

  await assert.rejects(
    async () => service.submitStaker({ ...stakerRow, network: "mainnet" }),
    /A2U_TESTNET_ONLY/
  );
  await assert.rejects(
    async () => service.submitOwner({ ...ownerRow, status: "approved" }, "pi-owner-uid"),
    /A2U_WITHDRAWAL_NOT_PROCESSING/
  );

  console.log(JSON.stringify({
    staker_payment_id_and_txid_persisted: true,
    owner_payment_id_and_txid_persisted: true,
    same_identifier_retry_idempotent: true,
    conflicting_payment_id_rejected: true,
    conflicting_txid_rejected: true,
    mainnet_row_rejected: true,
    non_processing_row_rejected: true,
    persistence_is_testnet_scoped: true,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
