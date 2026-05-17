const express = require("express");
const cors = require("cors");
const Pi = require("pi-backend");

const app = express();

app.use(cors());
app.use(express.json());

/* ===============================
   PI SDK INIT
=============================== */

Pi.init({
  apiKey: process.env.PI_API_KEY,
  walletPrivateSeed: process.env.WALLET_PRIVATE_SEED,
  sandbox: true
});

/* ===============================
   ROOT
=============================== */

app.get("/", (req, res) => {

  res.send("ALBUKHR TEST API RUNNING 🚀");

});

/* ===============================
   CHECK ENV
=============================== */

app.get("/check-key", (req, res) => {

  res.json({
    hasKey: !!process.env.PI_API_KEY,
    hasSeed: !!process.env.WALLET_PRIVATE_SEED
  });

});

/* ===============================
   APPROVE PAYMENT
=============================== */

app.post("/approve-payment", async (req, res) => {

  try {

    const { paymentId } = req.body;

    console.log("APPROVING PAYMENT:", paymentId);

    const payment = await Pi.approvePayment(paymentId);

    console.log("APPROVED SUCCESS");

    res.send({
      success: true,
      payment
    });

  } catch (err) {

    console.error(
      "APPROVE ERROR:",
      err.response?.data || err.message
    );

    res.status(500).send({
      success: false,
      error:
        err.response?.data ||
        err.message
    });

  }

});

/* ===============================
   COMPLETE PAYMENT
=============================== */

app.post("/complete-payment", async (req, res) => {

  try {

    const { paymentId, txid } = req.body;

    console.log("COMPLETING PAYMENT:", paymentId);

    const payment =
      await Pi.completePayment(paymentId, txid);

    console.log("COMPLETE SUCCESS");

    res.send({
      success: true,
      payment
    });

  } catch (err) {

    console.error(
      "COMPLETE ERROR:",
      err.response?.data || err.message
    );

    res.status(500).send({
      success: false,
      error:
        err.response?.data ||
        err.message
    });

  }

});

/* ===============================
   SERVER
=============================== */

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    "ALBUKHR PAYMENT SERVER RUNNING ON PORT",
    PORT
  );

});
