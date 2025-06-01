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
const SESSION_REMINDER_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes

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
    if (!phoneNumberId) {
      console.error("Phone Number ID is undefined");
      return;
    }
    const msgBody = message?.type === 'text'
      ? message.text.body.trim().toLowerCase()
      : message?.type === 'interactive'
        ? message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
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

  // 10-minute final timeout
  session.timeout = setTimeout(async () => {
    await sendMessage(session.phoneNumberId, session.from, "⏳ Your session has timed out. Please type *Hi* or *Hello* to start again.");
    sessions.delete(from);
  }, SESSION_TIMEOUT);  // 10 minutes

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
      } else if (msg.includes("fee structure")) {
        await sendFeeDetails(phoneNumberId, from);
        session.step = 'select_city';
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("join")) {
        await sendMessage(phoneNumberId, from, "📝 Register here: https://shunyamudra.com/register");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("talk")) {
        await sendMessage(phoneNumberId, from, "📝 Great! Please provide your details in the format:\n\n*Name*: Your Name\n*Email*: your.email@example.com\n*Phone number*: Your Whatsapp Number\n*City*: Your city(optional)\n*Query*: your query(optional)");
        // await sendRedirectButton(phoneNumberId, from);
        session.step = 'collect_user_details';
      } else if (msg.includes("concern")) {
        await sendMessage(phoneNumberId, from, "📝 Thank You for reaching out!☺️\nPlease write your concern in detail below.\n\nIf possible, please leave your name and phone number so that we can resolve your concern effectively.");
        session.step = 'collect_user_concern';
      } else if (msg.includes("feedback")) {
        await sendMessage(phoneNumberId, from, "📝 We value our customers!☺️\nPlease write down your feedback along with your name, phone number and location if possible.");
        session.step = 'collect_user_feedback';
      } else {
        await sendWelcome(phoneNumberId, from); // fallback
      }
      break;

    case 'select_class_type':
      if (msg.includes("regular batch-mumbai")) {
        await sendMessage(phoneNumberId, from, "🧘‍♀️ *Regular Adult Yoga*: \n\nMorning Batch\n6:45 AM - 7:45 AM\n7:45 AM - 8:45 AM\n8:45 AM - 9:45 AM\n10:30 AM - 11:30 AM\n\nEvening Batch\n6:30 PM - 7:30 PM\n7:30 PM - 8:30 PM\n\n🧘‍♀️ *Weekend Adult Yoga*: \n\nMorning Batch\n7:00 AM - 8:15 AM");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("regular batch-bangalore")) {
        await sendMessage(phoneNumberId, from, "🧘‍♀️ *Regular Adult Yoga*: \n\nMorning Batch\n6:30 AM - 7:30 AM\n8:00 AM - 9:00 AM\n\nEvening Batch\n7:00 PM - 8:00 AM");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("online batch")) {
        await sendMessage(phoneNumberId, from, "🧘‍♀️ *Online Batch Time*: \n\n9:30 AM - 10:30 AM");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("aerial")) {
        await sendMessage(phoneNumberId, from, "🧘‍♀️ *Aerial Batch Time*: \n\n8:45 AM - 9:45 AM on Saturdays and Sundays in Kharghar");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("meditation")) {
        await sendMessage(phoneNumberId, from, "🧘‍♀️ *Meditation Batch Time*: \n\n8:00 AM - 9:00 AM on Saturdays in Bangalore");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else {
        await sendMessage(phoneNumberId, from, "Please select a valid class type.");
        await sendClassTypeOptions(phoneNumberId, from);
      }
      break;
    
    case 'select_city':
      if (msg.includes("kharghar")) {
        await sendMessage(phoneNumberId, from, "💰 Fee Details at Shunyamudra Yoga & Wellness Center, Kharghar, Navi Mumbai:\n\n- Weekday Batch: ~₹3,000~ ₹2,500/month + ₹500 (one-time admission)\n- Weekend Batch: ₹2,000/month + ₹500 (one-time admission)\n- Aerial Yoga Batch: ₹3,200/month\n\n🧘‍♀️ We recommend bringing your own yoga mat and a bottle of water for comfort & convenience.");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("whitefield")) {
        await sendMessage(phoneNumberId, from, "💰 Fee Details at Shunyamudra Yoga & Wellness Center:\n\n- Weekday Batch: ₹2,600/month (Exclusive discount for Gopalan Aqua Residents)\n- Meditation Batch: ₹1,500/month\n\n🧘‍♀️ We recommend bringing your own yoga mat and a bottle of water for comfort & convenience.");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else if (msg.includes("online class")) {
        await sendMessage(phoneNumberId, from, "💰 Fee Details at Shunyamudra Yoga & Wellness Center:\n\n- Online Batch: ₹2,000/month\n\n🧘‍♀️ We recommend bringing your own yoga mat and a bottle of water for comfort & convenience.");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } else {
        await sendMessage(phoneNumberId, from, "Please select a city.");
        await sendFeeDetails(phoneNumberId, from);
      }
      break;

    case 'collect_user_details':{
        const lines = msgBody.trim().split(/\n|,|;/).map(l => l.trim()).filter(Boolean);
        
        const name = extractField(msgBody, lines, [/name\s*:\s*(.*)/i, /^(?!.*:)(.+)/i], 0);
        const email = extractField(msgBody, lines, [/email\s*:\s*(.*)/i, /^[^\s]+@[^\s]+\.[^\s]+$/i], 1);
        const number = extractField(msgBody, lines, [/phone\s*number\s*:\s*(.*)/i, /\b\d{10}\b/], 2);
        const location = extractField(msgBody, lines, [/location\s*:\s*(.*)/i, /city\s*:\s*(.*)/i], 3);
        const query = extractField(msgBody, lines, [/query\s*:\s*(.*)/i], 4);

      if (name && email && number) {
        // const name = nameMatch[1].trim();
        // const email = emailMatch[1].trim();
        // const number = numberMatch[1].trim();
        // const location = locationMatch?.[1]?.trim() || '';
        // const query = queryMatch?.[1]?.trim() || '';
        const finalLocation = location || 'Not provided';
        const finalQuery = query || 'Not provided';

        await sendMessage(phoneNumberId, from, `🙏 Thank you, ${name}! We've received your details. Our team will contact you soon.`);
        await sendYesNoButtons(phoneNumberId, from);

        // Notify the team
        const teamMessage = `New customer enquiry received:\n\n*Full Name*: ${name}\n*Phone No*: ${number}\n*Email Id*: ${email}\n*City*: ${finalLocation}\n*Query*: ${finalQuery}`;
        await sendMessage(phoneNumberId, WHATSAPP_NUMBER, teamMessage);

        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide your details in the correct format:\n\n`*Name*: Your Name\n*Email*: your.email@example.com\n*Phone No*: Your Whatsapp Number\n*City*: Your city(optional)\n*Query*: your query(optional)`");
        session.step = 'welcome';
      }
    }
      break;

    case 'collect_user_concern':
        const concern = msgBody.trim();

        if(concern){
        await sendMessage(phoneNumberId, from, `🙏 Thank you! We've noted your concern and our team is working on it to find a resolusion.\n\nIn the meantime, if you want to discuss directly with our trainer please call on 7777016109 between 12 PM to 4 PM.`);
        await sendYesNoButtons(phoneNumberId, from);

        // Notify the team
        const concernMessage = `New customer concern has been raised:\n\n${concern}`;
        await sendMessage(phoneNumberId, WHATSAPP_NUMBER, concernMessage);

        session.step = 'post_answer';
        }else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide correct concern");
        session.step = 'welcome';
      }
    break;

    case 'collect_user_feedback':{
      const feedback = msgBody.trim();

      if(feedback){
        await sendMessage(phoneNumberId, from, "🙏 Thank you for taking the time to share your feedback with us.\n\nWe truly value your input and will use it to improve your experience at *Shunyamudra Yoga & Wellness Center*.");
        await sendYesNoButtons(phoneNumberId, from);

        // Notify the team
        const feedbackMessage = `New customer feedback received:\n\n*Feedback*: ${feedback}`;
        await sendMessage(phoneNumberId, WHATSAPP_NUMBER, feedbackMessage);

        session.step = 'post_answer';
      }else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide correct feedback");
        session.step = 'welcome';
      }
    }
      break;

    case 'post_answer':
      if (msg === 'yes') {
        await sendWelcome(phoneNumberId, from);
        session.step = 'main_menu';
      } else if (msg === 'no') {
        await sendMessage(phoneNumberId, from, "Your wellness matters to us. Thanks for getting in touch with Shunyamudra Yoga & Wellness Center.");
        sessions.delete(from);
      } else {
        await sendMessage(phoneNumberId, from, "Would you like more assistance?");
        await sendYesNoButtons(phoneNumberId, from);
      }
      break;
    
    case 'post_answer_detail':
      if (msg === 'yes') {
        await sendMessage(phoneNumberId, from, "📝 Great! Please provide your details in the format:\n\n*Name*: Your Name\n*Email*: your.email@example.com\n*Phone number*: Your Whatsapp Number\n*City*: Your city(optional)\n\n*Query*: your query(optional)");
        session.step = 'collect_user_details';
      } else {
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
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
  await sendWhatsAppMessage(phoneNumberId, { to, text: { body: text }, type: 'text' });
}

function extractField(msgBody, lines, patterns, fallbackIndex) {
  for (const pattern of patterns) {
    const match = msgBody.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return lines[fallbackIndex]?.trim() || '';
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

async function checkToCollectDetails(phoneNumberId, to) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Shall we book a demo class for you to experience our sessions firsthand?" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_more_questions', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_more_questions', title: 'No' } }
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
  await sendListMessage(phoneNumberId, to, "🙏 ✨ Welcome to Shunyamudra Yoga & Wellness Center!\n\nLet’s begin your journey. Please tap one of the options below:", "Main Menu", [
    { id: "class_timings", title: "Class Timings?" },
    { id: "fee_structure", title: "Fee Structure?" },
    { id: "how_to_join", title: "How can I Join?" },
    { id: "talk_to_person", title: "Talk to our Trainer" },
    { id: "raise_concern", title: "Raise a concern" },
    { id: "feedback", title: "Provide a feedback" }
  ]);
}

async function sendClassTypeOptions(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, "🧘 We offer \nRegular offline and online batches\n- Aerial Yoga\n- Meditation", "Choose a Class Type", [
    { id: "class_regular_mum", title: "Regular Batch-Mumbai" },
    { id: "class_aerial", title: "Aerial Batch-Mumbai" },
    { id: "class_regular_blr", title: "Regular Batch-Bangalore" },
    { id: "class_meditation", title: "Meditation-Bangalore" },
    { id: "class_online", title: "Online Batch" }
  ]);
}

async function sendFeeDetails(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, "🧘 We are located in Kharghar, Navi Mumbai and Whitefield, Bangalore", "Choose a Location", [
    { id: "kharghar", title: "Kharghar, Navi Mumbai" },
    { id: "whitefield", title: "Whitefield, Bangalore" },
    { id: "online", title: "Online Class" }
  ]);
}

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
