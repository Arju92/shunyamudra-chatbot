const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'shunyamudra_token';
const WHATSAPP_REDIRECT_LINK = process.env.WHATSAPP_REDIRECT_LINK;
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const sessions = new Map();

// ==================== VERIFY WEBHOOK ====================
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook Verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ==================== HANDLE MESSAGES ====================
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phoneNumberId = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const from = message?.from;

    const msgBody = message?.type === 'text'
      ? message.text.body.trim().toLowerCase()
      : message?.type === 'interactive'
        ? message.button?.text || message.list_reply?.title
        : null;

    if (message && msgBody) {
      await handleMessage(phoneNumberId, from, msgBody);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Message handling error:", error.message);
    res.sendStatus(500);
  }
});

// ==================== SESSION MANAGEMENT ====================
function resetTimeout(from) {
  let session = sessions.get(from) || {};
  if (session.timeout) clearTimeout(session.timeout);

  session.timeout = setTimeout(async () => {
    await sendMessage(session.phoneNumberId, session.from, "⏳ Your session has timed out. Please type *Hi* or *Hello* to start again.");
    sessions.delete(from);
  }, SESSION_TIMEOUT);

  sessions.set(from, session);
}

// ==================== HANDLE INCOMING USER LOGIC ====================
async function handleMessage(phoneNumberId, from, msgBody) {
  resetTimeout(from);

  const session = sessions.get(from) || { step: 'welcome', phoneNumberId, from };
  const msg = msgBody.toLowerCase().replace(/[?]/g, '').trim();

  switch (session.step) {
    case 'welcome':
      await sendWelcome(phoneNumberId, from);
      session.step = 'main_menu';
      break;

    case 'main_menu':
      if (msg.includes("class timings")) {
        await sendClassTypeOptions(phoneNumberId, from);
        session.step = 'select_class_type';
      } else if (msg.includes("fee")) {
        await sendMessage(phoneNumberId, from, "💰 Monthly fee: ₹2500. Admission: ₹500 (one-time). Bring your yoga mat and water.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else if (msg.includes("join")) {
        await sendMessage(phoneNumberId, from, "📝 Register here: https://example.com/register");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else if (msg.includes("talk")) {
        await sendMessage(phoneNumberId, from, "👤 A representative will contact you shortly.");
        await sendRedirectButton(phoneNumberId, from);
        session.step = 'end';
      } else {
        await sendWelcome(phoneNumberId, from); // fallback
      }
      break;

    case 'select_class_type':
      if (msg.includes("regular")) {
        await sendClassTimings(phoneNumberId, from, 'regular');
        session.step = 'post_answer';
      } else if (msg.includes("aerial")) {
        await sendClassTimings(phoneNumberId, from, 'aerial');
        session.step = 'post_answer';
      } else if (msg.includes("meditation")) {
        await sendMessage(phoneNumberId, from, "🧘‍♀️ Meditation batch coming soon. We'll notify you.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "Please select a valid class type.");
        await sendClassTypeOptions(phoneNumberId, from);
      }
      break;

    case 'post_answer':
      if (msg === 'yes') {
        await sendWelcome(phoneNumberId, from);
        session.step = 'main_menu';
      } else if (msg === 'no') {
        await sendMessage(phoneNumberId, from, "🙏 Thank you for contacting Shunyamudra Yoga Studio.");
        sessions.delete(from);
      } else {
        await sendMessage(phoneNumberId, from, "Would you like more assistance?");
        await sendYesNoButtons(phoneNumberId, from);
      }
      break;

    default:
      await sendWelcome(phoneNumberId, from);
      session.step = 'main_menu';
      break;
  }

  sessions.set(from, session);
}

// ==================== WHATSAPP API MESSAGE HELPERS ====================
async function sendWhatsAppMessage(phoneNumberId, payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', ...payload },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error("❌ Failed to send message:", err.response?.data || err.message);
  }
}

async function sendMessage(phoneNumberId, to, text) {
  await sendWhatsAppMessage(phoneNumberId, { to, text: { body: text } });
}

async function sendYesNoButtons(phoneNumberId, to) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Do you have more questions?" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_more_questions', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_more_questions', title: 'No' } }
        ]
      }
    }
  });
}

async function sendRedirectButton(phoneNumberId, to) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Click below to chat directly." },
      action: {
        buttons: [
          { type: 'url', url: WHATSAPP_REDIRECT_LINK, title: 'Chat on WhatsApp' }
        ]
      }
    }
  });
}

async function sendListMessage(phoneNumberId, to, bodyText, title, options) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      header: { type: 'text', text: title },
      action: {
        button: "Show Options",
        sections: [{ title, rows: options }]
      }
    }
  });
}

// ==================== BOT MENUS ====================
async function sendWelcome(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, "🙏 Welcome to *Shunyamudra Yoga Studio*! How can we help you?", "Main Menu", [
    { id: "class_timings", title: "Class Timings?" },
    { id: "fee_structure", title: "Fee Structure?" },
    { id: "how_to_join", title: "How can I Join?" },
    { id: "talk_to_person", title: "Talk to a Person" }
  ]);
}

async function sendClassTypeOptions(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, "🧘 Types of Yoga available:\n- Hatha\n- Ashtanga\n- Vinyasa\n- Iyengar\n- Aerial Yoga\n- Meditation", "Choose a Class Type", [
    { id: "regular", title: "Regular Adult Batch" },
    { id: "aerial", title: "Aerial Yoga Batch" },
    { id: "meditation", title: "Meditation Batch" }
  ]);
}

async function sendClassTimings(phoneNumberId, to, type) {
  const timings = {
    regular: [
      { id: "slot1", title: "6:45 AM - 7:45 AM" },
      { id: "slot2", title: "7:45 AM - 8:45 AM" },
      { id: "slot3", title: "8:45 AM - 9:45 AM" },
      { id: "slot4", title: "10:30 AM - 11:30 AM" }
    ],
    aerial: [
      { id: "slot1", title: "6:00 PM - 7:00 PM (Tue/Thu/Sat)" }
    ]
  };

  await sendListMessage(phoneNumberId, to, `📅 Timings for ${type.charAt(0).toUpperCase() + type.slice(1)} Yoga:`, "Available Slots", timings[type]);
}

// ==================== SERVER START ====================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
