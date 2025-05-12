const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'shunyamudra_token';

const menuOptions = {
  class_timings: "Our classes are on Monday to Saturday and the batches are as follows:\n\n" +
    "🧘 Morning ->\n" +
    "6:45 AM - 7:45 AM\n" +
    "7:45 AM - 8:45 AM\n" +
    "8:45 AM - 9:45 AM\n" +
    "10:30 AM - 11:30 AM\n\n" +
    "🌇 Evening ->\n" +
    "6:45 PM - 7:45 PM\n" +
    "7:45 PM - 8:45 PM\n" +
    "For personal class or workshop, feel free to talk to our representative",
  fee_structure: 'Our monthly fee is ₹2500. Yoga mats and water are included.',
  join_info: 'To join, please fill our registration form on www.shunyamudra.com or visit our studio.'
};

// ✅ Webhook verification (Meta requirement)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified");
      res.status(200).send(challenge);
    } else {
      console.warn("❌ Webhook verification failed: invalid token");
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// ✅ Handle incoming messages and list selections
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const phone_number_id = changes.value.metadata.phone_number_id;
      const from = message.from;

      // ✅ Handle list reply
      if (message?.interactive?.list_reply?.id) {
        const payload = message.interactive.list_reply.id;

        if (payload === "talk_person_v2") {
          await sendRedirectButton(phone_number_id, from);
        } else {
          const replyText = menuOptions[payload] || "Sorry, I didn't understand your selection.";
          await sendMessage(phone_number_id, from, replyText);
        }
      }

      // ✅ Handle greetings
      else if (message?.text?.body &&
        (message.text.body.toLowerCase().includes('hi') ||
         message.text.body.toLowerCase().includes('hello'))) {
        await sendMenu(phone_number_id, from);
      }

      // ✅ Handle fallback
      else if (message?.text?.body) {
        const fallback = `Hi! Please type "hi" to see the available options.`;
        await sendMessage(phone_number_id, from, fallback);
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ✅ Send a regular text message
async function sendMessage(phoneNumberId, to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error("❌ Error sending message:", error.response?.data || error.message);
  }
}

// ✅ Send a list-style interactive menu
async function sendMenu(phoneNumberId, to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: {
            text: "Welcome to Shunyamudra Yoga Studio! How can we help you today?"
          },
          footer: {
            text: "Select an option from the list below"
          },
          action: {
            button: "Show Options",
            sections: [
              {
                title: "Yoga Studio FAQs",
                rows: [
                  {
                    id: "class_timings",
                    title: "Class Timings?"
                  },
                  {
                    id: "fee_structure",
                    title: "Fee Structure?"
                  },
                  {
                    id: "join_info",
                    title: "How can I Join?"
                  },
                  {
                    id: "talk_person_v2",
                    title: "Talk to a Person"
                  }
                ]
              }
            ]
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error("❌ Error sending menu:", error.response?.data || error.message);
  }
}

// ✅ Send a redirect button to WhatsApp chat of instructor
async function sendRedirectButton(phoneNumberId, to) {
  const whatsappLink = process.env.WHATSAPP_REDIRECT_LINK;

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "Please click below to talk directly to our Head Instructor:"
          },
          action: {
            buttons: [
              {
                type: "url",
                url: whatsappLink,
                title: "Talk to Representative"
              }
            ]
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error("❌ Error sending redirect button:", error.response?.data || error.message);
  }
}

// ✅ Health check route
app.get('/', (req, res) => {
  res.send('Shunyamudra Chatbot is Live');
});

app.listen(PORT, () => {
  console.log(`🚀 Bot is running on port ${PORT}`);
});
