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

// ==================== WEBHOOK VERIFICATION ====================
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook Verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ==================== MESSAGE HANDLER ====================
app.post('/webhook', async (req, res) => {
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phoneNumberId = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const from = message?.from;

    if (!phoneNumberId) {
      console.error("❌ Missing Phone Number ID");
      return res.sendStatus(400);
    }

    const msgBody = message?.type === 'text'
      ? message.text.body.trim().toLowerCase()
      : message?.type === 'interactive'
        ? message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
        : null;

    if (message && msgBody) {
      await handleMessage(phoneNumberId, from, msgBody, message);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Message handling error:", error.message);
    res.sendStatus(500);
  }
});

// ==================== CORE FUNCTIONS ====================
function extractUserDetails(msgBody) {
  const nameMatch = msgBody.match(/\*?name\*?\s*[:\-]?\s*(.*)/i);
  const emailMatch = msgBody.match(/\*?email\*?\s*[:\-]?\s*(.*)/i);
  let userName = nameMatch ? nameMatch[1].trim() : null;
  let userEmail = emailMatch ? emailMatch[1].trim() : null;

  if (!userName || !userEmail) {
    const lines = msgBody.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    lines.forEach(line => {
      if (!userEmail && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}$/i.test(line)) {
        userEmail = line;
      } else if (!userName && !line.toLowerCase().includes("email")) {
        userName = line.replace(/^name[:\-]?\s*/i, '').trim();
      }
    });
  }
  return { userName, userEmail };
}

function extractCityKey(userCity) {
  const lowerCity = userCity.toLowerCase();
  if (lowerCity.includes("mumbai")) return "mumbai";
  if (lowerCity.includes("bangalore")) return "bangalore";
  if (lowerCity.includes("other")) return "others";
}

function resetTimeout(phoneNumberId, from) {
  let session = sessions.get(from) || {};
  if(session.finalTimeout) clearAllTimeouts(session.finalTimeout);

  session.followUp1 = setTimeout(async () => {
    await sendMessage(phoneNumberId, from, "⏳ We didn't hear from you for a while. Would you like a demo?");
    await sendYesNoButtons(phoneNumberId, from);
  }, 30 * 60 * 1000);

  session.followUp2 = setTimeout(async () => {
    await sendMessage(phoneNumberId, from, "🙏 Just checking in again. Want to try a free demo class?");
    await sendYesNoButtons(phoneNumberId, from);
  }, 60 * 60 * 1000);

  session.finalTimeout = setTimeout(async () => {
    await sendMessage(phoneNumberId, from, 
      "⏳ Session timed out.\n\nYour wellness matters to us. Thanks for connecting with *Shunyamudra Yoga & Wellness Center*.\n\nType *Hi* to restart.");
    sessions.delete(from);
  }, 65 * 60 * 1000);

  sessions.set(from, session);
}

function clearAllTimeouts(session) {
  ['timeout', 'followUp1', 'followUp2', 'finalTimeout'].forEach(t => clearTimeout(session[t]));
}

function formatExtraInfo(text) {
  if (!text) return 'N/A';
  return text
    .replace(/[\s\n\r\t]+/g, '_')  // replace all space-like characters with underscores
    .replace(/_{5,}/g, '____')     // prevent excessive underscores (e.g., 10+ becomes 4)
    .trim();
}

async function notifyTeam(phoneNumberId, session, enquiry, extraInfo = '') {
  console.log(phoneNumberId, WHATSAPP_NUMBER, session, enquiry, extraInfo);
  await sendTeamMessage(phoneNumberId, WHATSAPP_NUMBER, session, enquiry, extraInfo);
}

// ==================== MESSAGE FLOW LOGIC ====================
async function handleMessage(phoneNumberId, from, msgBody) {
  resetTimeout(from);
  const session = sessions.get(from) || { step: 'welcome', phoneNumberId, from };
  const msg = msgBody.toLowerCase().replace(/[?]/g, '').trim();

  switch (session.step) {
    case 'welcome':
      if (["hi", "hello", "hey", "namaste", "namasthe"].includes(msg)) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Welcome! Please share your *Name* and *Email*.\n\nExample:\n*Name*: John Doe\n*Email*: john@example.com");
        session.step = 'collect_initial_details';
      } else {
        await sendMessage(phoneNumberId, from, "👋 Type *Hi*, *Hello*, or *Namaste* to begin.");
      }
      break;

    case 'collect_initial_details':
    const { userName, userEmail } = extractUserDetails(msgBody);
    if (userName && userEmail) {
      Object.assign(session, { userName, userEmail, userPhoneNumber: from });
      await sendMessage(phoneNumberId, from, `Thank you, *${userName}*!`);
      await checkCustomerStatus(phoneNumberId, from);
      session.step = 'check_status'; // Add this new step
    } else {
      await sendMessage(phoneNumberId, from, 
        "⚠️ Please provide *Name* and *Email* correctly.\n\nExample:\n*Name*: John Doe\n*Email*: john@example.com");
    }
    break;

    case 'check_status':
    if (msg.includes("new")) {
      session.userStatus = 'new client';
      await sendSelectCity(phoneNumberId, from);
      session.step = 'select_city';
    } else if (msg.includes("existing")) {
      session.userStatus = 'existing client';
      await sendSelectCity(phoneNumberId, from);
      session.step = 'select_city';
    } else {
      await checkCustomerStatus(phoneNumberId, from);
    }
    break;

    case 'select_city':
      session.userCity = msg;
      if (msg.includes("mumbai") || msg.includes("bangalore")) {
        if (session.userStatus === 'new client') {
          await sendClassMode(phoneNumberId, from);
          session.step = 'class_mode';
        } else if (session.userStatus === 'existing client') {
          await sendExistingWelcome(phoneNumberId, from);
          session.step = 'main_menu';
        }
      } else if (msg.includes("others")) {
        if (session.userStatus === 'new client') {
          await sendMessage(phoneNumberId, from, 
            "🧘‍♀️ We’re currently in Mumbai/Bangalore. Join our online batch:\n\n*Timings*: Mon/Tue/Thu/Fri, 9:30 AM - 10:30 AM");
          await checkToCollectDetails(phoneNumberId, from);
          session.step = 'post_answer_detail';
        } else if (session.userStatus === 'existing client') {
          await sendExistingWelcome(phoneNumberId, from);
          session.step = 'main_menu';
        }
      } else {
        await sendMessage(phoneNumberId, from, "Please select a city.");
        session.step = 'welcome';
      }
      break;

    case 'class_mode':
      if (msg.includes("studio")) {
        await sendNewWelcome(phoneNumberId, from);
        session.step = 'main_menu';
      } else if (msg.includes("personal")) {
        const className = "Personal Class Enquiry";
        await sendMessage(phoneNumberId, from, "🙏 Our team will contact you shortly for personal sessions.");
        await notifyTeam(phoneNumberId, session, className, `*Request*:${className}`);
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "Please select a class mode.");
        await sendClassMode(phoneNumberId, from);
      }
      break;

    case 'main_menu':
      if (msg.includes("class timings")) {
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
        const cityKey = extractCityKey(session.userCity);

        if (cityKey === "others") {
          await sendMessage(phoneNumberId, from, "🙏 We're currently offering sessions only in Mumbai and Bangalore.");
        } else {
          await sendMessage(phoneNumberId, from, cityTimings[cityKey]);
        }

        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("fee structure")) {
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
        const cityKey = extractCityKey(session.userCity);
        
        if (cityKey === "others") {
          await sendMessage(phoneNumberId, from, "🙏 We're currently offering sessions only in Mumbai and Bangalore.");
        } else {
          await sendMessage(phoneNumberId, from, cityFees[cityKey]);
        }

        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("join")) {
        await sendMessage(phoneNumberId, from, "📝 Register here: https://shunyamudra.com/register");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("talk")) {
        await sendMessage(phoneNumberId, from, "📞 Our trainer will call you shortly.");
        await notifyTeam(phoneNumberId, session, "Demo Enquiry", "*Request*:Callback");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else if (msg.includes("refer")) {
        await sendMessage(phoneNumberId, from, "👥 Share the referral's name & number.");
        session.step = 'collect_user_referral';
      } else if (msg.includes("concern")) {
        await sendMessage(phoneNumberId, from, "📝 Describe your concern below.");
        session.step = 'collect_user_concern';
      } else if (msg.includes("feedback")) {
        await sendMessage(phoneNumberId, from, "🌟 We’d love your feedback!");
        session.step = 'collect_user_feedback';
      } else {
        await sendSelectCity(phoneNumberId, from, session.userName);
      }
      break;

    case 'collect_user_referral':
      if (msg.trim()) {
        const formattedMsg = formatExtraInfo(msg);
        await notifyTeam(phoneNumberId, session, "Referral", `*Referral*: ${formattedMsg}`);
        await sendMessage(phoneNumberId, from, "🙏 Thank you! We’ll contact them soon.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide valid details.");
      }
      break;

    case 'collect_user_concern':
      if (msg.trim()) {
        const formattedMsg = formatExtraInfo(msg);
        await notifyTeam(phoneNumberId, session, "Concern", `*Concern*: ${formattedMsg}`);
        await sendMessage(phoneNumberId, from, "🙏 We’ve noted your concern. Call us at 7777016109 (12 PM - 4 PM) for urgent queries.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please describe your concern.");
      }
      break;

    case 'collect_user_feedback':
      if (msg.trim()) {
        const formattedMsg = formatExtraInfo(msg);
        await notifyTeam(phoneNumberId, session, "Feedback", `*Feedback*: ${formattedMsg}`);
        await sendMessage(phoneNumberId, from, "🌟 Thank you for your feedback!");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide valid feedback.");
      }
      break;

    case 'post_answer':
      if (msg === 'yes') {
        if (session.userStatus === 'new client') {
          await sendNewWelcome(phoneNumberId, from);
          session.step = 'main_menu';
        } else {
          await sendExistingWelcome(phoneNumberId, from);
          session.step = 'main_menu';
        }
      } else if (msg === 'no') {
        await sendMessage(phoneNumberId, from, "🙏 Thank you for connecting with us!");
        sessions.delete(from);
      } else {
        await sendYesNoButtons(phoneNumberId, from);
      }
      break;

    case 'post_answer_detail':
      if (msg === 'yes') {
        await sendMessage(phoneNumberId, from, "📞 Our trainer will call you shortly.");
        await notifyTeam(phoneNumberId, session, "Demo Enquiry", "*Request*:Callback");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      }
      break;

    default:
      await sendSelectCity(phoneNumberId, from, session.userName);
      session.step = 'main_menu';
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


async function sendMessage(phoneNumberId, to, text) {
  await sendWhatsAppMessage(phoneNumberId, { to, text: { body: text }, type: 'text' });
}

async function sendTeamMessage(phoneNumberId, to, session, enquiry, extraInfo = '') {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'template',
    template: {
      name: 'team_notify', // all lowercase, underscores instead of spaces
      language: { code: 'en_US' },
      components: [
        {
          type: 'body',
          parameters: [
              { type: 'text', text: enquiry || 'N/A' },
              { type: 'text', text: session.userName || 'N/A' },
              { type: 'text', text: session.userPhoneNumber || 'N/A' },
              { type: 'text', text: session.userEmail || 'N/A' },
              { type: 'text', text: session.userCity || 'N/A' },
              { type: 'text', text: extraInfo || 'None' }
            ]
        }
      ]
    }
  });
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