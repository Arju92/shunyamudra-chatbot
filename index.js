const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ✅ Predefined questions and answers
const questions = {
  hi: `Welcome to Shunyamudra Yoga Studio! Please reply with:
1. What are your class timings?
2. What is the fee structure?
3. How to join?
4. Talk to a person`,
  '1': 'Our class timings are 6 AM to 8 PM from Monday to Saturday.',
  '2': 'Our monthly fee is ₹2000. Yoga mats and water are included.',
  '3': 'To join, please fill our registration form on www.shunyamudra.com or visit our studio.',
  '4': 'Please wait while I connect you to a staff member...'
};

// ✅ Webhook verification (required by Meta)
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = "shunyamudra_token"; // This must match the token set in Meta portal

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log("Webhook verified successfully");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403); // Token mismatch
    }
  } else {
    res.sendStatus(400); // Missing required query params
  }
});

// ✅ Message handling logic
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message && message.text) {
      const phone_number_id = changes.value.metadata.phone_number_id;
      const from = message.from;
      const msg_text = message.text.body.toLowerCase();

      const reply = questions[msg_text] || `Sorry, I didn't understand. Please reply with a number 1-4.`;

      try {
        await axios.post(
          `https://graph.facebook.com/v18.0/${phone_number_id}/messages`,
          {
            messaging_product: 'whatsapp',
            to: from,
            text: { body: reply }
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (error) {
        console.error("Error sending message:", error.response?.data || error.message);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ✅ Basic route to confirm server is running
app.get('/', (req, res) => {
  res.send('Shunyamudra Chatbot is Live');
});

app.listen(PORT, () => {
  console.log(`Bot is listening on port ${PORT}`);
});
