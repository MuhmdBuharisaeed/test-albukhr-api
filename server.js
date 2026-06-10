const express = require("express");
const cors = require("cors");
const axios = require("axios");

const { createClient } =
require("@supabase/supabase-js");

const StellarSdk =
require("stellar-sdk");

const app = express();

app.use(cors());
app.use(express.json());

const supabase =
createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const server =
new StellarSdk.Horizon.Server(
  "https://api.testnet.minepi.com"
);

app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK"
  });
});

/* ===================================
   APPROVE PAYMENT
=================================== */
app.post("/approve", async (req, res) => {

  try {

    const paymentId = req.body.paymentId;

    console.log("APPROVING PAYMENT:", paymentId);

    console.log(
      "PI API KEY EXISTS:",
      !!process.env.PI_API_KEY
    );

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      {
        headers: {
          Authorization: `Key ${process.env.PI_API_KEY}`
        }
      }
    );

    console.log("APPROVED SUCCESS");

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {

    console.log(
      "APPROVE ERROR:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error:
        error.response?.data ||
        error.message
    });

  }

});

/* ===================================
   COMPLETE PAYMENT
=================================== */
app.post("/complete", async (req, res) => {

  try {

    const { paymentId, txid } = req.body;

    console.log("COMPLETING PAYMENT:", paymentId);

    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      { txid },
      {
        headers: {
          Authorization: `Key ${process.env.PI_API_KEY}`
        }
      }
    );

    console.log("COMPLETED SUCCESS");

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {

    console.log(
      "COMPLETE ERROR:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error:
        error.response?.data ||
        error.message
    });

  }

});

/* ===================================
   GET WITHDRAW REQUEST
=================================== */
app.post("/withdraw", async (req, res) => {

  try {

    const { requestId } = req.body;

    if(!requestId){
      return res.status(400).json({
        error: "Missing requestId"
      });
    }

    const { data, error } =
      await supabase
        .from("withdraw_requests")
        .select("*")
        .eq("id", requestId)
        .single();

    if(error || !data){
      return res.status(404).json({
        error: "Request not found"
      });
    }

    if(data.status !== "approved"){
      return res.status(400).json({
        error: "Request not approved"
      });
    }

    return res.json({
      success: true,
      request: data
    });

  } catch(err){

    console.log(err);

    return res.status(500).json({
      error: err.message
    });

  }

});

app.get("/test-supabase", async (req,res)=>{

  try{

    const { data, error } =
      await supabase
        .from("withdraw_requests")
        .select("*")
        .limit(1);

    if(error){
      return res.status(500).json({
        error:error.message
      });
    }

    res.json({
      success:true,
      rows:data
    });

  }catch(err){

    res.status(500).json({
      error:err.message
    });

  }

});

app.get("/test-stellar", async (req,res)=>{

  try{

    const account =
      await server.loadAccount(
        "GA6JI5N5HZIVG3VD5PM7W4U6DXPT73AZ5CHYURU2YJDPLPL77Q5KPCMD"
      );

    res.json({
      success:true,
      sequence:account.sequence
    });

  }catch(error){

    res.status(500).json({
      success:false,
      error:error.message
    });

  }

});

app.get("/test-wallet", (req, res) => {

  try {

    const kp =
      StellarSdk.Keypair.fromSecret(
        process.env.WALLET_PRIVATE_SEED
      );

    res.json({
      success: true,
      publicKey: kp.publicKey()
    });

  } catch(err){

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(
    `ALBUKHR PAYMENT SERVER RUNNING ON PORT ${PORT}`
  );
});
