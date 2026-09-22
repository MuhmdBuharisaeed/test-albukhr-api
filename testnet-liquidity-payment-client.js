/* ALBUKHR TESTNET LIQUIDITY PAYMENT CLIENT v1 */
(function (window) {
  "use strict";

  /*
   * This module is intentionally NOT loaded automatically by the
   * current Testnet pages. It is the controlled client integration
   * layer for the next payment-testing step.
   *
   * It uses:
   *   - ALBUKHR Testnet gateway session for application access;
   *   - Testnet Pi SDK accessToken only in memory for Pi-side identity
   *     verification during payment callbacks;
   *   - no localStorage;
   *   - no Mainnet Pi access token;
   *   - no payment secrets in browser storage.
   */

  var API_BASE = "https://test-albukhr-api.onrender.com";
  var NETWORK = "testnet";
  var PI_SDK_VERSION = "2.0";
  /*
   * This is the hosted ALBUKHR Testnet app, not Pi's local Sandbox URL.
   * Keep sandbox:false here. Set sandbox:true only for an actual Pi Sandbox
   * development URL registered in the Pi Developer Portal.
   */
  var PI_SANDBOX = false;

  var initialized = false;
  var authResult = null;
  var pendingIncompletePayments = [];
  var authenticationPromise = null;

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function getAuth() {
    var auth = window.AlbukhrTestnetAuth;
    if (!auth || typeof auth.requireTestnetAuth !== "function") {
      throw new Error("TESTNET_AUTH_MODULE_UNAVAILABLE");
    }
    return auth;
  }

  function getSessionToken() {
    var token = clean(getAuth().getSessionToken());
    if (!token) throw new Error("TESTNET_SESSION_REQUIRED");
    return token;
  }

  function validateEnvironment() {
    var env = window.ALBukhrEnvironment;
    if (!env || !env.isKnown || !env.isTestnet || !env.getNetwork) {
      throw new Error("TESTNET_ENVIRONMENT_UNAVAILABLE");
    }
    if (!env.isKnown() || !env.isTestnet() || env.getNetwork() !== NETWORK) {
      throw new Error("INVALID_TESTNET_ENVIRONMENT");
    }
    if (clean(env.getHostname && env.getHostname()).toLowerCase() !== "test.albukhr.com") {
      throw new Error("TESTNET_HOST_REQUIRED");
    }
  }

  function requirePiSdk() {
    if (!window.Pi || typeof window.Pi.init !== "function" || typeof window.Pi.authenticate !== "function" || typeof window.Pi.createPayment !== "function") {
      throw new Error("PI_SDK_UNAVAILABLE");
    }
    return window.Pi;
  }

  function dispatch(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (_) {}
  }

  async function apiRequest(path, body, includePiToken) {
    var sessionToken = getSessionToken();
    var headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Testnet-Session": sessionToken
    };

    if (includePiToken) {
      var piToken = clean(authResult && authResult.accessToken);
      if (!piToken) throw new Error("PI_ACCESS_TOKEN_REQUIRED");
      headers.Authorization = "Bearer " + piToken;
    }

    var response = await fetch(
      API_BASE.replace(/\/+$/, "") + "/liquidity-payment/" + clean(path).replace(/^\/+/, ""),
      {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body || {})
      }
    );

    var data = null;
    try {
      data = await response.json();
    } catch (_) {}

    if (!response.ok) {
      var code = clean(data && data.error) || "TESTNET_LIQUIDITY_PAYMENT_ERROR";
      var error = new Error(code);
      error.status = response.status;
      error.body = data;
      throw error;
    }

    return data;
  }

  async function recoverIncomplete(payment) {
    if (!payment) return null;

    var identifier = clean(payment.identifier || payment.id);
    if (!identifier) return null;

    try {
      var response = await fetch(
        API_BASE.replace(/\/+$/, "") + "/liquidity-payment/incomplete",
        {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            paymentId: identifier,
            identifier: identifier,
            txid: clean(payment.transaction && payment.transaction.txid) || null
          })
        }
      );

      var result = null;
      try {
        result = await response.json();
      } catch (_) {}

      if (!response.ok) {
        var error = new Error(
          clean(result && (result.error || result.message)) ||
          "TESTNET_LIQUIDITY_RECOVERY_FAILED"
        );
        error.status = response.status;
        error.body = result;
        throw error;
      }

      dispatch("albukhr:testnet-liquidity-payment-recovered", result);
      return result;
    } catch (error) {
      console.error("[ALBUKHR TESTNET LIQUIDITY RECOVERY]", error);
      dispatch("albukhr:testnet-liquidity-payment-recovery-error", { error: error, payment: payment });
      throw error;
    }
  }

  async function authenticate() {
    validateEnvironment();
    await getAuth().requireTestnetAuth({ redirectOnFailure: false });

    if (authenticationPromise) return authenticationPromise;

    authenticationPromise = (async function () {
      var pi = requirePiSdk();

      if (!initialized) {
        pi.init({
          version: PI_SDK_VERSION,
          sandbox: PI_SANDBOX
        });
        initialized = true;
      }

      pendingIncompletePayments = [];

      var result = await pi.authenticate(
        ["username", "payments"],
        function onIncompletePaymentFound(payment) {
          if (payment) pendingIncompletePayments.push(payment);
        }
      );

      if (!result || !clean(result.accessToken) || !result.user || !clean(result.user.uid)) {
        throw new Error("PI_AUTH_RESULT_INVALID");
      }

      /*
       * Keep the Testnet Pi access token memory-only.
       * Never store it in localStorage/sessionStorage/cookies.
       */
      authResult = {
        accessToken: result.accessToken,
        user: {
          uid: clean(result.user.uid),
          username: clean(result.user.username) || null
        }
      };

      for (var i = 0; i < pendingIncompletePayments.length; i += 1) {
        await recoverIncomplete(pendingIncompletePayments[i]);
      }

      pendingIncompletePayments = [];

      dispatch("albukhr:testnet-liquidity-pi-authenticated", {
        username: authResult.user.username,
        uid: authResult.user.uid
      });

      return {
        user: authResult.user
      };
    })();

    try {
      return await authenticationPromise;
    } finally {
      authenticationPromise = null;
    }
  }

  async function createLiquidityPayment(project, amount) {
    validateEnvironment();

    var safeProject = project || {};
    var projectId = clean(safeProject.id);
    var projectCode = clean(safeProject.project_code);

    if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
    if (!projectCode) throw new Error("PROJECT_CODE_REQUIRED");
    if (clean(safeProject.network).toLowerCase() !== NETWORK) {
      throw new Error("PROJECT_NETWORK_INVALID");
    }

    var value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("INVALID_LIQUIDITY_AMOUNT");
    }

    await authenticate();

    var pi = requirePiSdk();
    var memo = "ALBUKHR Testnet liquidity • " + projectCode;

    return new Promise(function (resolve, reject) {
      pi.createPayment(
        {
          amount: value,
          memo: memo,
          metadata: {
            network: NETWORK,
            action: "add_liquidity",
            project_id: projectId,
            project_code: projectCode
          }
        },
        {
          onReadyForServerApproval: async function (paymentId) {
            try {
              var approved = await apiRequest(
                "approve",
                {
                  paymentId: paymentId,
                  projectId: projectId,
                  projectCode: projectCode
                },
                true
              );

              dispatch("albukhr:testnet-liquidity-payment-approved", approved);
            } catch (error) {
              console.error("[ALBUKHR TESTNET LIQUIDITY APPROVAL]", error);
              dispatch("albukhr:testnet-liquidity-payment-approval-error", { error: error, paymentId: paymentId });
              throw error;
            }
          },

          onReadyForServerCompletion: async function (paymentId, txid) {
            try {
              var completed = await apiRequest(
                "complete",
                {
                  paymentId: paymentId,
                  projectId: projectId,
                  projectCode: projectCode,
                  txid: txid
                },
                true
              );

              dispatch("albukhr:testnet-liquidity-payment-completed", completed);
              resolve(completed);
            } catch (error) {
              console.error("[ALBUKHR TESTNET LIQUIDITY COMPLETION]", error);
              dispatch("albukhr:testnet-liquidity-payment-completion-error", { error: error, paymentId: paymentId, txid: txid });
              throw error;
            }
          },

          onCancel: function (paymentId) {
            dispatch("albukhr:testnet-liquidity-payment-cancelled", { paymentId: paymentId, network: NETWORK });
            reject(new Error("PI_PAYMENT_CANCELLED"));
          },

          onError: function (error, payment) {
            console.error("[ALBUKHR TESTNET LIQUIDITY PAYMENT]", error, payment || null);
            dispatch("albukhr:testnet-liquidity-payment-error", { error: error, payment: payment || null });
            reject(error instanceof Error ? error : new Error("PI_PAYMENT_ERROR"));
          }
        }
      );
    });
  }

  function clearInMemoryPiAuth() {
    authResult = null;
    pendingIncompletePayments = [];
  }

  window.AlbukhrTestnetLiquidityPayment = Object.freeze({
    authenticate: authenticate,
    createLiquidityPayment: createLiquidityPayment,
    recoverIncomplete: recoverIncomplete,
    clearInMemoryPiAuth: clearInMemoryPiAuth,
    network: NETWORK,
    apiBase: API_BASE
  });
})(window);
