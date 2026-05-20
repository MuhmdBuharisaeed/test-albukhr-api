const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK"
  });
});

// APPROVE PAYMENT
app.post("/approve", async (req, res) => {
  try {
    const paymentId = req.body.paymentId;

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      {
        headers: {
          Authorization: `Key YOUR_PI_API_KEY`
        }
      }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    console.error("APPROVE ERROR:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// COMPLETE PAYMENT
app.post("/complete", async (req, res) => {
  try {
    const { paymentId, txid } = req.body;

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      { txid },
      {
        headers: {
          Authorization: `Key YOUR_PI_API_KEY`
        }
      }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    console.error("COMPLETE ERROR:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`ALBUKHR PAYMENT SERVER RUNNING ON PORT ${PORT}`);
});
