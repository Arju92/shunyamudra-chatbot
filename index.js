const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'shunyamudra_token';
const WHATSAPP_REDIRECT_LINK = process.env.WHATSAPP_REDIRECT_LINK
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const sessions = new Map();

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook Verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Message handler
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object) {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];

      if (message && message.type === 'text') {
        const phoneNumberId = changes.value.metadata.phone_number_id;
        const from = message.from;
        const msgBody = message.text.body.trim().toLowerCase();

        await handleMessage(phoneNumberId, from, msgBody);
      } else if (message && message.type === 'interactive') {
        const phoneNumberId = changes.value.metadata.phone_number_id;
        const from = message.from;
        const msgBody = message.button?.text || message.list_reply?.title;

        await handleMessage(phoneNumberId, from, msgBody);
      }

      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("Error handling incoming message:", error);
    res.sendStatus(500);
  }
});

async function handleMessage(phoneNumberId, from, msgBody) {
  resetTimeout(from);

  const session = sessions.get(from) || { step: 'welcome' };

  switch (session.step) {
    case 'welcome':
      await sendWelcome(phoneNumberId, from);
      session.step = 'main_menu';
      break;

    case 'main_menu':
      if (msgBody.includes("class timings")) {
        await sendClassTypeOptions(phoneNumberId, from);
        session.step = 'select_class_type';
      } else if (msgBody.includes("fee")) {
        await sendMessage(phoneNumberId, from, "Our monthly fee is ₹2500 with a one-time ₹500 admission charge. Please bring your own yoga mat and water.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else if (msgBody.includes("join")) {
        await sendMessage(phoneNumberId, from, "You can register by clicking this link: https://example.com/register");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else if (msgBody.includes("talk")) {
        await sendMessage(phoneNumberId, from, "Our representative will get back to you shortly. Thank you for your patience.");
        await sendRedirectButton(phoneNumberId, from);
        session.step = 'end';
      } else {
        await sendWelcome(phoneNumberId, from);
      }
      break;

    case 'select_class_type':
      if (msgBody.includes("regular")) {
        await sendClassTimings(phoneNumberId, from, 'regular');
        session.step = 'post_answer';
      } else if (msgBody.includes("aerial")) {
        await sendClassTimings(phoneNumberId, from, 'aerial');
        session.step = 'post_answer';
      } else if (msgBody.includes("meditation")) {
        await sendMessage(phoneNumberId, from, "We are going to start the meditation batch soon. We will let you know the details as soon as possible.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      }
      break;

    case 'post_answer':
      if (msgBody === 'yes') {
        await sendWelcome(phoneNumberId, from);
        session.step = 'main_menu';
      } else if (msgBody === 'no') {
        await sendMessage(phoneNumberId, from, "Thank you for contacting Shunyamudra Yoga Studio. Have a great day!");
        sessions.delete(from);
      }
      break;

    default:
      await sendWelcome(phoneNumberId, from);
      session.step = 'main_menu';
      break;
  }

  sessions.set(from, session);
}

function resetTimeout(from) {
  const session = sessions.get(from);
  if (session?.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(() => sessions.delete(from), SESSION_TIMEOUT);
  sessions.set(from, session || {});
}

async function sendWelcome(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, "Welcome to Shunyamudra Yoga Studio! How can we help you today?", "Select an option", [
    { id: "class_timings", title: "Class Timings?" },
    { id: "fee_structure", title: "Fee Structure?" },
    { id: "how_to_join", title: "How can I Join?" },
    { id: "talk_to_person", title: "Talk to a Person" }
  ]);
}

async function sendClassTypeOptions(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, "We have different types of yoga:\n\n- Hatha\n- Ashtanga\n- Vinyasa\n- Iyengar (props)\n- Aerial Yoga\n- Meditation", "Which one are you looking for?", [
    { id: "regular", title: "Regular Adult Batch" },
    { id: "aerial", title: "Aerial Yoga Batch" },
    { id: "meditation", title: "Meditation Batch" }
  ]);
}

async function sendClassTimings(phoneNumberId, to, type) {
  let timings = [];

  if (type === 'regular') {
    timings = [
      { id: "slot1", title: "6:45 AM - 7:45 AM" },
      { id: "slot2", title: "7:45 AM - 8:45 AM" },
      { id: "slot3", title: "8:45 AM - 9:45 AM" },
      { id: "slot4", title: "10:30 AM - 11:30 AM" },
      { id: "slot5", title: "6:45 PM - 7:45 PM" },
      { id: "slot6", title: "7:45 PM - 8:45 PM" }
    ];
    await sendListMessage(phoneNumberId, to, "Our classes are on Monday to Friday.\n\nPlease choose your preferred batch:", "Batch Timings", timings);
  } else {
    timings = [
      { id: "slot1", title: "6:45 AM - 7:45 AM" },
      { id: "slot2", title: "7:45 AM - 8:45 AM" }
    ];
    await sendListMessage(phoneNumberId, to, "Aerial Yoga classes are on Saturday and Sunday.\n\nPlease choose your preferred batch:", "Batch Timings", timings);
  }

  await sendYesNoButtons(phoneNumberId, to);
}

async function sendYesNoButtons(phoneNumberId, to) {
  await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Do you have any more questions?" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_more_questions', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_more_questions', title: 'No' } }
        ]
      }
    }
  }, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

async function sendRedirectButton(phoneNumberId, to) {
  await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Click below to talk directly on WhatsApp." },
      action: {
        buttons: [
          { type: 'url', url: WHATSAPP_REDIRECT_LINK, title: 'Chat on WhatsApp' }
        ]
      }
    }
  }, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

async function sendMessage(phoneNumberId, to, text) {
  await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    text: { body: text }
  }, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

async function sendListMessage(phoneNumberId, to, bodyText, title, options) {
  await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      header: { type: "text", text: title },
      action: {
        button: "Show Options",
        sections: [
          {
            title: title,
            rows: options
          }
        ]
      }
    }
  }, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
