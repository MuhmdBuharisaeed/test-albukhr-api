
"use strict";

// ALBUKHR Testnet Owner Withdrawal Reconciliation Server Mount Smoke Test.
//
// Starts the actual server.js Express application on loopback and verifies
// the mounted /outflow-fee/owner/reconcile HTTP endpoint.
//
// Supabase is mocked. No production database, Pi API, Horizon payout,
// wallet secret, transaction signing, or payment submission is used.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const express = require("express");

const TESTNET_ORIGIN = "http://127.0.0.1";
const SESSION_TOKEN =
  "ALBUKHR-SERVER-MOUNT-REGRESSION-SESSION";

const INVALID_SESSION_TOKEN =
  "ALBUKHR-SERVER-MOUNT-INVALID-SESSION";

const PI_UID = "PI-SERVER-MOUNT-OWNER-TEST";
const WITHDRAWAL_ID =
  "00000000-0000-4000-8000-000000000401";

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

const VALID_SESSION_HASH = sha256(SESSION_TOKEN);

const state = {
  supabaseClientCreated: 0,
  reads: [],
  rpcCalls: [],
};

const sessionRow = {
  id: "server-mount-session-id",
  session_hash: VALID_SESSION_HASH,
  pi_uid: PI_UID,
  username: "server-mount-owner",
  wallet_address: "GTESTNETOWNERWALLET",
  network: "testnet",
  expires_at: "2099-01-01T00:00:00.000Z",
  revoked_at: null,
};

const supabaseMock = {
  from(table) {
    const filters = [];
    let selectedColumns = null;

    const query = {
      select(columns) {
        selectedColumns = columns;
        return query;
      },

      eq(column, value) {
        filters.push([column, value]);
        return query;
      },

      async maybeSingle() {
        state.reads.push({
          table,
          columns: selectedColumns,
          filters: filters.map((item) => [...item]),
        });

        // Only a matching Testnet session exists in this mock.
        // No owner user or withdrawal record is provided.
        const row =
          table === "testnet_sessions"
            ? sessionRow
            : null;

        const matches =
          row &&
          filters.every(([column, expected]) => {
            return String(
              row[column] == null ? "" : row[column]
            ) === String(
              expected == null ? "" : expected
            );
          });

        return {
          data: matches ? { ...row } : null,
          error: null,
        };
      },
    };

    return query;
  },

  async rpc(name, args) {
    state.rpcCalls.push({
      name,
      args,
    });

    return {
      data: null,
      error: new Error(
        "DATABASE_RPC_MUST_NOT_RUN_IN_SERVER_MOUNT_TEST"
      ),
    };
  },
};

const environmentKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PI_API_KEY",
  "TESTNET_ORIGIN",
  "PORT",
  "WALLET_PRIVATE_SEED",
  "PI_TESTNET_APP_WALLET",
];

const previousEnvironment = new Map(
  environmentKeys.map((key) => [
    key,
    process.env[key],
  ])
);

function restoreEnvironment() {
  for (const [key, previousValue] of previousEnvironment) {
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
}

function hasFilter(read, column, expected) {
  return Boolean(
    read &&
    read.filters.some(
      ([name, value]) =>
        name === column &&
        value === expected
    )
  );
}

async function closeServer(server) {
  if (!server || !server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitForServer(server) {
  if (server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function main() {
  const originalModuleLoad = Module._load;
  const originalListen = express.application.listen;

  let httpServer = null;

  process.env.SUPABASE_URL =
    "https://albukhr-server-mount-test.supabase.co";

  process.env.SUPABASE_SERVICE_ROLE_KEY =
    "MOCK-SUPABASE-SERVICE-ROLE-KEY";

  process.env.PI_API_KEY =
    "MOCK-PI-API-KEY";

  process.env.TESTNET_ORIGIN = TESTNET_ORIGIN;
  process.env.PORT = "0";

  // Never load or use a payout wallet secret in this test.
  delete process.env.WALLET_PRIVATE_SEED;
  delete process.env.PI_TESTNET_APP_WALLET;

  try {
    // Replace only the Supabase client constructor.
    // Express, CORS, server.js and the application routers remain real.

    Module._load = function patchedModuleLoad(
      request,
      parent,
      isMain
    ) {
      if (request === "@supabase/supabase-js") {
        return {
          createClient() {
            state.supabaseClientCreated += 1;
            return supabaseMock;
          },
        };
      }

      return originalModuleLoad.call(
        this,
        request,
        parent,
        isMain
      );
    };

    // Capture the real Express application and bind it to an
    // ephemeral loopback port instead of the production port.

    express.application.listen = function patchedListen(
      requestedPort,
      ...args
    ) {
      httpServer = originalListen.call(
        this,
        0,
        "127.0.0.1",
        ...args
      );

      return httpServer;
    };

    // Loading this file creates the actual Express application,
    // mounts all routers, registers middleware and calls app.listen().
    require("../server.js");

    assert.ok(
      httpServer,
      "SERVER_EXPRESS_LISTENER_WAS_NOT_CAPTURED"
    );

    // Restore module and Express hooks immediately after startup.
    Module._load = originalModuleLoad;
    express.application.listen = originalListen;

    await waitForServer(httpServer);

    const address = httpServer.address();

    assert.ok(
      address && typeof address.port === "number",
      "SERVER_LOOPBACK_ADDRESS_UNAVAILABLE"
    );

    const endpoint =
      `http://127.0.0.1:${address.port}` +
      "/outflow-fee/owner/reconcile";

    // ---------------------------------------------------------
    // 1. CORS preflight must allow the Testnet session header.
    // ---------------------------------------------------------

    const preflight = await fetch(endpoint, {
      method: "OPTIONS",

      headers: {
        Origin: TESTNET_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type,x-testnet-session",
      },
    });

    assert.equal(preflight.status, 204);

    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      TESTNET_ORIGIN
    );

    const allowedHeaders = String(
      preflight.headers.get(
        "access-control-allow-headers"
      ) || ""
    ).toLowerCase();

    assert.ok(
      allowedHeaders.includes("x-testnet-session"),
      "CORS_MUST_ALLOW_TESTNET_SESSION_HEADER"
    );

    assert.equal(
      state.reads.length,
      0,
      "CORS_PREFLIGHT_MUST_NOT_READ_DATABASE"
    );

    // ---------------------------------------------------------
    // 2. The actual mounted route must reject a missing session.
    // ---------------------------------------------------------

    const missingSessionResponse = await fetch(endpoint, {
      method: "POST",

      headers: {
        Origin: TESTNET_ORIGIN,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        withdrawalId: WITHDRAWAL_ID,
      }),
    });

    assert.equal(
      missingSessionResponse.status,
      401
    );

    const missingSessionBody =
      await missingSessionResponse.json();

    assert.equal(
      missingSessionBody.error,
      "TESTNET_SESSION_REQUIRED"
    );

    assert.equal(
      state.reads.length,
      0,
      "MISSING_SESSION_MUST_BE_REJECTED_BEFORE_DATABASE_READ"
    );

    // ---------------------------------------------------------
    // 3. An invalid session must fail the hashed session lookup.
    // ---------------------------------------------------------

    const invalidSessionResponse = await fetch(endpoint, {
      method: "POST",

      headers: {
        Origin: TESTNET_ORIGIN,
        "Content-Type": "application/json",
        "X-Testnet-Session": INVALID_SESSION_TOKEN,
      },

      body: JSON.stringify({
        withdrawalId: WITHDRAWAL_ID,
      }),
    });

    assert.equal(
      invalidSessionResponse.status,
      401
    );

    const invalidSessionBody =
      await invalidSessionResponse.json();

    assert.equal(
      invalidSessionBody.error,
      "TESTNET_SESSION_INVALID"
    );

    const invalidSessionRead =
      state.reads.find(
        (item) => item.table === "testnet_sessions"
      );

    assert.ok(
      hasFilter(
        invalidSessionRead,
        "session_hash",
        sha256(INVALID_SESSION_TOKEN)
      ),
      "SESSION_TOKEN_MUST_BE_HASHED_BEFORE_LOOKUP"
    );

    assert.ok(
      hasFilter(
        invalidSessionRead,
        "network",
        "testnet"
      ),
      "SESSION_LOOKUP_MUST_BE_TESTNET_SCOPED"
    );

    // ---------------------------------------------------------
    // 4. A valid Testnet session must reach owner identity lookup.
    //
    // The mock intentionally has no owner row. The expected
    // response is 403 OWNER_IDENTITY_UNAVAILABLE.
    //
    // This also proves that Express parsed the JSON body:
    // otherwise the route would stop at WITHDRAWAL_ID_REQUIRED.
    // ---------------------------------------------------------

    const validSessionResponse = await fetch(endpoint, {
      method: "POST",

      headers: {
        Origin: TESTNET_ORIGIN,
        "Content-Type": "application/json",
        "X-Testnet-Session": SESSION_TOKEN,
      },

      body: JSON.stringify({
        withdrawalId: WITHDRAWAL_ID,
      }),
    });

    assert.equal(
      validSessionResponse.status,
      403
    );

    const validSessionBody =
      await validSessionResponse.json();

    assert.equal(
      validSessionBody.error,
      "OWNER_IDENTITY_UNAVAILABLE"
    );

    const userRead = state.reads.find(
      (item) => item.table === "users"
    );

    assert.ok(
      userRead,
      "VALID_SESSION_MUST_REACH_OWNER_IDENTITY_LOOKUP"
    );

    assert.ok(
      hasFilter(
        userRead,
        "pi_uid",
        PI_UID
      ),
      "OWNER_LOOKUP_MUST_USE_SESSION_PI_UID"
    );

    assert.ok(
      hasFilter(
        userRead,
        "network",
        "testnet"
      ),
      "OWNER_LOOKUP_MUST_BE_TESTNET_SCOPED"
    );

    // ---------------------------------------------------------
    // 5. No withdrawal lookup, fee RPC or payout may happen
    // before owner identity is established.
    // ---------------------------------------------------------

    assert.deepEqual(
      state.reads.map((item) => item.table),
      [
        "testnet_sessions",
        "testnet_sessions",
        "users",
      ]
    );

    assert.equal(
      state.rpcCalls.length,
      0,
      "NO_FEE_OR_SETTLEMENT_RPC_ALLOWED"
    );

    assert.equal(
      state.reads.some(
        (item) =>
          item.table === "project_owner_withdrawals"
      ),
      false,
      "WITHDRAWAL_MUST_NOT_BE_READ_BEFORE_OWNER_IDENTITY"
    );

    console.log(JSON.stringify({
      suite:
        "owner-withdrawal-reconciliation-server-mount-smoke",

      result: "PASS",

      actual_server_js_loaded: true,
      actual_express_application_started: true,

      actual_http_route_reached:
        "POST /outflow-fee/owner/reconcile",

      cors_preflight_passed: true,
      testnet_session_header_allowed: true,
      json_body_parser_reached: true,

      missing_session_rejected: true,
      invalid_session_rejected: true,
      session_hash_verified: true,

      valid_session_reached_owner_identity_check: true,
      owner_identity_lookup_testnet_scoped: true,

      withdrawal_lookup_before_owner_identity: false,
      fee_or_settlement_rpc_calls: 0,

      supabase_client_mocked: true,
      database_writes: false,

      external_api_requests: false,
      horizon_payout_lookup: false,
      wallet_secrets_used: false,
      transactions_signed: false,
      payments_submitted: false,

      http_requests_were_loopback_only: true,
    }, null, 2));

  } finally {
    Module._load = originalModuleLoad;
    express.application.listen = originalListen;

    await closeServer(httpServer);

    restoreEnvironment();

    // Avoid retaining the server entry point in this test process.
    try {
      delete require.cache[
        require.resolve("../server.js")
      ];
    } catch (_) {
      // The entry point may not have completed loading.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
