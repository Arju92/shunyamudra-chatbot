const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'shunyamudra_token';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER;

const sessions = new Map();

const STATES = {
  WELCOME: 'welcome',
  COLLECT_INITIAL_DETAILS: 'collect_initial_details',
  CHECK_STATUS: 'check_status',
  SELECT_CITY: 'select_city',
  CLASS_MODE: 'class_mode',
  MAIN_MENU: 'main_menu',
  COLLECT_USER_REFERRAL: 'collect_user_referral',
  COLLECT_USER_CONCERN: 'collect_user_concern',
  COLLECT_USER_FEEDBACK: 'collect_user_feedback',
  POST_ANSWER: 'post_answer',
  POST_ANSWER_DETAIL: 'post_answer_detail'
};

const FOLLOW_UP_TIMES = {
  FOLLOW_UP_1: 30 * 60 * 1000, // 30 min
  FOLLOW_UP_2: 60 * 60 * 1000, // 60 min
  FINAL_TIMEOUT: 65 * 60 * 1000 // 65 min
};

// ==================== WEBHOOK VERIFICATION ====================
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook Verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ==================== MESSAGE HANDLER ====================
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    const from = message?.from;

    if (!phoneNumberId) {
      console.error("❌ Missing Phone Number ID");
      return res.sendStatus(400);
    }
    if (!message || !from) {
      // No message to process; just respond 200 OK
      return res.sendStatus(200);
    }

    console.log(`Received message from ${from} on number ID ${phoneNumberId}`);

    const msgBody = getMessageText(message);
    if (!msgBody) {
      // Unsupported message type; ignore gracefully
      return res.sendStatus(200);
    }

    await handleMessage(phoneNumberId, from, msgBody, message);
    return res.sendStatus(200);

  } catch (error) {
    console.error("❌ Message handling error:", error);
    res.sendStatus(500);
  }
});

function getMessageText(message) {
  if (message.type === 'text' && message.text?.body) {
    return message.text.body.trim();
  }
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || null;
  }
  return null;
}

// ==================== SESSION MANAGEMENT & TIMEOUTS ====================
function clearSessionTimeouts(session) {
  ['followUp1', 'followUp2', 'finalTimeout'].forEach((key) => {
    if (session[key]) {
      clearTimeout(session[key]);
      session[key] = null;
    }
  });
}

function resetTimeout(from) {
  let session = sessions.get(from) || {};
  clearSessionTimeouts(session);

  session.followUp1 = setTimeout(async () => {
    await sendMessage(phoneNumberId, from, "⏳ We didn't hear from you for a while. Would you like a demo?");
    await sendYesNoButtons(phoneNumberId, from);
  }, FOLLOW_UP_TIMES.FOLLOW_UP_1);

  session.followUp2 = setTimeout(async () => {
    await sendMessage(phoneNumberId, from, "🙏 Just checking in again. Want to try a free demo class?");
    await sendYesNoButtons(phoneNumberId, from);
  }, FOLLOW_UP_TIMES.FOLLOW_UP_2);

  session.finalTimeout = setTimeout(async () => {
    await sendMessage(phoneNumberId, from,
      "⏳ Session timed out.\n\nYour wellness matters to us. Thanks for connecting with *Shunyamudra Yoga & Wellness Center*.\n\nType *Hi* to restart.");
    sessions.delete(from);
  }, FOLLOW_UP_TIMES.FINAL_TIMEOUT);

  sessions.set(from, session);
}

// ==================== HELPER FUNCTIONS ====================
function extractUserDetails(msgBody) {
  const nameMatch = msgBody.match(/\*?name\*?\s*[:\-]?\s*(.*)/i);
  const emailMatch = msgBody.match(/\*?email\*?\s*[:\-]?\s*(.*)/i);
  let userName = nameMatch ? nameMatch[1].trim() : null;
  let userEmail = emailMatch ? emailMatch[1].trim() : null;

  if (!userName || !userEmail) {
    // fallback if explicit name/email lines not found
    const lines = msgBody.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!userEmail && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}$/i.test(line)) {
        userEmail = line;
      } else if (!userName && !line.toLowerCase().includes('email')) {
        userName = line.replace(/^name[:\-]?\s*/i, '').trim();
      }
      if (userName && userEmail) break;
    }
  }

  return { userName, userEmail };
}

function extractCityKey(userCity) {
  if (!userCity) return "others";
  const lowerCity = userCity.toLowerCase();
  if (lowerCity.includes("mumbai")) return "mumbai";
  if (lowerCity.includes("bangalore")) return "bangalore";
  return "others";
}

async function notifyTeam(phoneNumberId, session, enquiry, extraInfo = '') {
  const details = [
    enquiry,
    session.userName || "N/A",
    session.userPhoneNumber || "N/A",
    session.userEmail || "N/A",
    session.userCity || "N/A",
    extraInfo
  ];
  console.log(phoneNumberId, WHATSAPP_NUMBER, 'customer_details', details);
  await sendTemplateMessage(phoneNumberId, WHATSAPP_NUMBER, 'customer_details', details);
}

function normalizeInput(msg) {
  return msg.toLowerCase().replace(/[?]/g, '').trim();
}

// ==================== MESSAGE FLOW LOGIC ====================
async function handleMessage(phoneNumberId, from, msgBody) {
  resetTimeout(from);

  const session = sessions.get(from) || { step: STATES.WELCOME, phoneNumberId, from };
  const msg = normalizeInput(msgBody);

  switch (session.step) {
    case STATES.WELCOME: {
      if (['hi', 'hello', 'hey', 'namaste', 'namasthe'].includes(msg)) {
        await sendMessage(phoneNumberId, from,
          "🙏 Welcome! Please share your *Name* and *Email*.\n\nExample:\n*Name*: John Doe\n*Email*: john@example.com");
        session.step = STATES.COLLECT_INITIAL_DETAILS;
      } else {
        await sendMessage(phoneNumberId, from, "👋 Type *Hi*, *Hello*, or *Namaste* to begin.");
      }
      break;
    }

    case STATES.COLLECT_INITIAL_DETAILS: {
      const { userName, userEmail } = extractUserDetails(msgBody);
      if (userName && userEmail) {
        Object.assign(session, { userName, userEmail, userPhoneNumber: from });
        await sendMessage(phoneNumberId, from, `Thank you, *${userName}*!`);
        await checkCustomerStatus(phoneNumberId, from);
        session.step = STATES.CHECK_STATUS;
      } else {
        await sendMessage(phoneNumberId, from,
          "⚠️ Please provide *Name* and *Email* correctly.\n\nExample:\n*Name*: John Doe\n*Email*: john@example.com");
      }
      break;
    }

    case STATES.CHECK_STATUS: {
      if (msg.includes("new")) {
        session.userStatus = 'new client';
        await sendSelectCity(phoneNumberId, from);
        session.step = STATES.SELECT_CITY;
      } else if (msg.includes("existing")) {
        session.userStatus = 'existing client';
        await sendSelectCity(phoneNumberId, from);
        session.step = STATES.SELECT_CITY;
      } else {
        await checkCustomerStatus(phoneNumberId, from);
      }
      break;
    }

    case STATES.SELECT_CITY: {
      session.userCity = msgBody.toLowerCase();

      const cityIsValid = ['mumbai', 'bangalore', 'others'].some(city => msg.includes(city));
      if (!cityIsValid) {
        await sendMessage(phoneNumberId, from, "Please select a city.");
        session.step = STATES.WELCOME;
        break;
      }

      if (msg.includes('mumbai') || msg.includes('bangalore')) {
        if (session.userStatus === 'new client') {
          await sendClassMode(phoneNumberId, from);
          session.step = STATES.CLASS_MODE;
        } else {
          await sendExistingWelcome(phoneNumberId, from);
          session.step = STATES.MAIN_MENU;
        }
      } else { // others
        if (session.userStatus === 'new client') {
          await sendMessage(phoneNumberId, from,
            "🧘‍♀️ We’re currently in Mumbai/Bangalore. Join our online batch:\n\n*Timings*: Mon/Tue/Thu/Fri, 9:30 AM - 10:30 AM");
          await checkToCollectDetails(phoneNumberId, from);
          session.step = STATES.POST_ANSWER_DETAIL;
        } else {
          await sendExistingWelcome(phoneNumberId, from);
          session.step = STATES.MAIN_MENU;
        }
      }
      break;
    }

    case STATES.CLASS_MODE: {
      if (msg.includes("studio")) {
        await sendNewWelcome(phoneNumberId, from);
        session.step = STATES.MAIN_MENU;
      } else if (msg.includes("personal")) {
        const className = "Personal Class";
        await sendMessage(phoneNumberId, from, "🙏 Our team will contact you shortly for personal sessions.");
        await notifyTeam(phoneNumberId, session, className, `*Request*: ${className}`);
        await sendYesNoButtons(phoneNumberId, from);
        session.step = STATES.POST_ANSWER;
      } else {
        await sendMessage(phoneNumberId, from, "Please select a class mode.");
        await sendClassMode(phoneNumberId, from);
      }
      break;
    }

    case STATES.MAIN_MENU: {
      const cityKey = extractCityKey(session.userCity);
      switch (true) {
        case msg.includes("class timings"): {
          const cityTimings = {
            mumbai:
              "🧘‍♀️ *Batch times at Kharghar, Navi Mumbai*: \n" +
              "🧘‍♀️ *Regular Weekday Batch*: \n\n" +
              "Morning Batch\nMonday to Friday\n" +
              "6:45 AM - 7:45 AM\n7:45 AM - 8:45 AM\n" +
              "8:45 AM - 9:45 AM\n10:30 AM - 11:30 AM\n\n" +
              "Evening Batch\n6:30 PM - 7:30 PM\n7:30 PM - 8:30 PM\n\n\n" +
              "🧘‍♀️ *Weekend Batch*: \n\nMorning Batch\nSaturday & Sunday\n7:00 AM - 8:15 AM\n\n\n" +
              "🧘‍♀️ *Aerial Yoga Batch*: \n\nMorning Batch\nSaturday & Sunday\n8:30 AM - 9:45 AM",

            bangalore:
              "🧘‍♀️ *Batch times at Whitefield, Bangalore*: \n" +
              "🧘‍♀️ *Regular Weekday Batch*: \n\n" +
              "Morning Batch\nMonday, Tuesday, Thursday, Friday\n" +
              "6:30 AM - 7:30 AM\n8:00 AM - 9:00 AM\n\n" +
              "Evening Batch\n7:00 PM - 8:00 PM\n\n\n" +
              "🧘‍♀️ *Meditation Batch*: \n\nMorning Batch\nSaturday only\n8:00 AM - 9:00 AM"
          };

          if (cityKey === "others") {
            await sendMessage(phoneNumberId, from, "🙏 We're currently offering sessions only in Mumbai and Bangalore.");
          } else {
            await sendMessage(phoneNumberId, from, cityTimings[cityKey]);
          }
          await checkToCollectDetails(phoneNumberId, from);
          session.step = STATES.POST_ANSWER_DETAIL;
          break;
        }

        case msg.includes("fee structure"): {
          const cityFees = {
            mumbai:
              "💰 Fee Details at Shunyamudra Yoga & Wellness Center, Kharghar, Navi Mumbai:\n\n" +
              "- Weekday Batch: ~₹3,000~ ₹2,500/month + ₹500 (one-time admission)\n" +
              "- Weekend Batch: ₹2,000/month + ₹500 (one-time admission)\n" +
              "- Aerial Yoga Batch: ₹3,200/month\n\n" +
              "🧘‍♀️ We recommend bringing your own yoga mat and a bottle of water for comfort & convenience.",

            bangalore:
              "💰 Fee Details at Shunyamudra Yoga & Wellness Center, Whitefield, Bangalore:\n\n" +
              "- Weekday Batch: ₹2,600/month (Exclusive discount for Gopalan Aqua Residents)\n" +
              "- Meditation Batch: ₹1,500/month\n\n" +
              "🧘‍♀️ We recommend bringing your own yoga mat and a bottle of water for comfort & convenience."
          };

          if (cityKey === "others") {
            await sendMessage(phoneNumberId, from, "🙏 We're currently offering sessions only in Mumbai and Bangalore.");
          } else {
            await sendMessage(phoneNumberId, from, cityFees[cityKey]);
          }
          await checkToCollectDetails(phoneNumberId, from);
          session.step = STATES.POST_ANSWER_DETAIL;
          break;
        }

        case msg.includes("join"): {
          await sendMessage(phoneNumberId, from, "📝 Register here: https://shunyamudra.com/register");
          await checkToCollectDetails(phoneNumberId, from);
          session.step = STATES.POST_ANSWER_DETAIL;
          break;
        }

        case msg.includes("talk"): {
          await sendMessage(phoneNumberId, from, "📞 Our trainer will call you shortly.");
          await notifyTeam(phoneNumberId, session, "Demo Enquiry", "*Request*: Callback");
          await sendYesNoButtons(phoneNumberId, from);
          session.step = STATES.POST_ANSWER;
          break;
        }

        case msg.includes("refer"): {
          await sendMessage(phoneNumberId, from, "👥 Share the referral's name & number.");
          session.step = STATES.COLLECT_USER_REFERRAL;
          break;
        }

        case msg.includes("concern"): {
          await sendMessage(phoneNumberId, from, "📝 Describe your concern below.");
          session.step = STATES.COLLECT_USER_CONCERN;
          break;
        }

        case msg.includes("feedback"): {
          await sendMessage(phoneNumberId, from, "🌟 We’d love your feedback!");
          session.step = STATES.COLLECT_USER_FEEDBACK;
          break;
        }

        default:
          await sendSelectCity(phoneNumberId, from, session.userName);
          session.step = STATES.MAIN_MENU;
      }
      break;
    }

    case STATES.COLLECT_USER_REFERRAL: {
      if (msg.trim()) {
        await notifyTeam(phoneNumberId, session, "Referral", `*Referral*: ${msg}`);
        await sendMessage(phoneNumberId, from, "🙏 Thank you! We’ll contact them soon.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = STATES.POST_ANSWER;
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide valid details.");
      }
      break;
    }

    case STATES.COLLECT_USER_CONCERN: {
      if (msg.trim()) {
        await notifyTeam(phoneNumberId, session, "Concern", `*Concern*: ${msg}`);
        await sendMessage(phoneNumberId, from,
          "🙏 We’ve noted your concern. Call us at 7777016109 (12 PM - 4 PM) for urgent queries.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = STATES.POST_ANSWER;
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please describe your concern.");
      }
      break;
    }

    case STATES.COLLECT_USER_FEEDBACK: {
      if (msg.trim()) {
        await notifyTeam(phoneNumberId, session, "Feedback", `*Feedback*: ${msg}`);
        await sendMessage(phoneNumberId, from, "🌟 Thank you for your feedback!");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = STATES.POST_ANSWER;
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide valid feedback.");
      }
      break;
    }

    case STATES.POST_ANSWER: {
      if (msg === 'yes') {
        if (session.userStatus === 'new client') {
          await sendNewWelcome(phoneNumberId, from);
        } else {
          await sendExistingWelcome(phoneNumberId, from);
        }
        session.step = STATES.MAIN_MENU;
      } else if (msg === 'no') {
        await sendMessage(phoneNumberId, from, "🙏 Thank you for connecting with us!");
        sessions.delete(from);
      } else {
        await sendYesNoButtons(phoneNumberId, from);
      }
      break;
    }

    case STATES.POST_ANSWER_DETAIL: {
      if (msg === 'yes') {
        await sendMessage(phoneNumberId, from, "📞 Our trainer will call you shortly.");
        await notifyTeam(phoneNumberId, session, "Demo Enquiry", "*Request*: Callback");
        await sendYesNoButtons(phoneNumberId, from);
      } else {
        await sendYesNoButtons(phoneNumberId, from);
      }
      session.step = STATES.POST_ANSWER;
      break;
    }

    default: {
      await sendSelectCity(phoneNumberId, from, session.userName);
      session.step = STATES.MAIN_MENU;
    }
  }

  sessions.set(from, session);
}

// ==================== WHATSAPP API HELPERS ====================
async function sendWhatsAppMessage(phoneNumberId, payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', ...payload },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error("❌ Failed to send message:", err.response?.data || err.message);
  }
}

async function sendTemplateMessage(phoneNumberId, to, templateName, parameters = []) {
  const payload = {
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: parameters.map(text => ({ type: "text", text }))
        }
      ]
    }
  };

  await sendWhatsAppMessage(phoneNumberId, payload);
}

async function sendMessage(phoneNumberId, to, text) {
  await sendWhatsAppMessage(phoneNumberId, { to, text: { body: text }, type: 'text' });
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
          { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no', title: 'No' } }
        ]
      }
    }
  });
}

async function checkCustomerStatus(phoneNumberId, to) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Are you a new or existing client?" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'new', title: '🆕 New Client' } },
          { type: 'reply', reply: { id: 'existing', title: '🧘‍♀️ Existing Client' } }
        ]
      }
    }
  });
}

async function checkToCollectDetails(phoneNumberId, to) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Want to book a demo class?" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no', title: 'No' } }
        ]
      }
    }
  });
}

async function sendClassMode(phoneNumberId, to) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Choose class mode:" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'studio', title: 'In Studio' } },
          { type: 'reply', reply: { id: 'personal', title: 'Personal Class' } }
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

// ==================== MENUS ====================
async function sendSelectCity(phoneNumberId, to, userName = '') {
  await sendListMessage(phoneNumberId, to,
    `🙏 Welcome${userName ? `, ${userName}` : ''}! Choose your city:`,
    "City",
    [
      { id: "mumbai", title: "Kharghar, Mumbai" },
      { id: "bangalore", title: "Whitefield, Bangalore" },
      { id: "others", title: "Other Location" }
    ]
  );
}

async function sendNewWelcome(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to,
    "What would you like to know?",
    "Main Menu",
    [
      { id: "class_timings", title: "Class Timings" },
      { id: "fee_structure", title: "Fee Structure" },
      { id: "how_to_join", title: "How to Join" },
      { id: "talk_to_person", title: "Talk to Trainer" }
    ]
  );
}

async function sendExistingWelcome(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to,
    "How can we help?",
    "Main Menu",
    [
      { id: "refer", title: "Refer a Friend" },
      { id: "concern", title: "Raise Concern" },
      { id: "feedback", title: "Give Feedback" }
    ]
  );
}

// ==================== SERVER START ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});