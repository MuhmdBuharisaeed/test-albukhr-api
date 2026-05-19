const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pi } = require("pi-backend");

const app = express();

const pi = new Pi({
  apiKey: process.env.PI_API_KEY,
  walletPrivateSeed: process.env.PI_WALLET_PRIVATE_SEED,
  network: "Pi Testnet"
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("ALBUKHR PI PAYMENT API RUNNING");
});

// APPROVE
app.post("/approve-payment", async (req, res) => {

  try {

    const paymentId = req.body.paymentId;

    console.log("APPROVING:", paymentId);

    await pi.approvePayment(paymentId);

    res.json({
      success: true,
      paymentId
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      error: error.message
    });

  }

});

// COMPLETE
app.post("/complete-payment", async (req, res) => {

  try {

    const paymentId = req.body.paymentId;
    const txid = req.body.txid;

    console.log("COMPLETING:", paymentId);

    await pi.completePayment(paymentId, txid);

    res.json({
      success: true,
      paymentId,
      txid
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      error: error.message
    });

  }

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("SERVER RUNNING");
});
