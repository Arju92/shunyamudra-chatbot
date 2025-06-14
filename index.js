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

// ==================== SESSION MANAGEMENT ====================
function resetTimeout(from) {
  let session = sessions.get(from) || {};
  if (session.timeout) clearTimeout(session.timeout);
  if (session.followUp1) clearTimeout(session.followUp1);
  if (session.followUp2) clearTimeout(session.followUp2);
  if (session.finalTimeout) clearTimeout(session.finalTimeout);

  // Follow-up after 30 minutes
  session.followUp1 = setTimeout(async () => {
    await sendMessage(session.phoneNumberId, session.from, "⏳ We didn't hear from you for a while. Would you be interested in a demo?");
    await sendYesNoButtons(session.phoneNumberId, session.from);
  }, 30 * 60 * 1000);

  // Follow-up after 60 minutes
  session.followUp2 = setTimeout(async () => {
    await sendMessage(session.phoneNumberId, session.from, "🙏 Just checking in again. Would you still like to try a free demo class?");
    await sendYesNoButtons(session.phoneNumberId, session.from);
  }, 60 * 60 * 1000);

  // Final timeout after 65 minutes
  session.finalTimeout = setTimeout(async () => {
    await sendMessage(session.phoneNumberId, session.from, "⏳ Your session has timed out.\n\nYour wellness matters to us. Thanks for getting in touch with *Shunyamudra Yoga & Wellness Center*.\n\nTo restart, please type *Hi* or *Hello*.");
    sessions.delete(from);
  }, 65 * 60 * 1000);

  sessions.set(from, session);
}

// ==================== HANDLE INCOMING USER LOGIC ====================
async function handleMessage(phoneNumberId, from, msgBody, message) {
  resetTimeout(from);

  const session = sessions.get(from) || { step: 'welcome', phoneNumberId, from };
  const msg = msgBody.toLowerCase().replace(/[?]/g, '').trim();

  // Handle button replies first
  if (message?.type === 'interactive' && message.interactive?.button_reply?.id) {
    const buttonId = message.interactive.button_reply.id;
    
    if (session.step === 'select_client_type') {
      if (buttonId === 'new_client') {
        session.clientType = 'new';
        await welcomeNewCust(phoneNumberId, from, session.userName);
        session.step = 'new_main_menu';
        sessions.set(from, session);
        return;
      } else if (buttonId === 'existing_client') {
        session.clientType = 'existing';
        await sendWelcome(phoneNumberId, from, session.userName);
        session.step = 'main_menu';
        sessions.set(from, session);
        return;
      }
    }
  }

  switch (session.step) {
    case 'welcome':
      if (["hi", "hello", "hey", "namaste", "namasthe"].includes(msg)) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Welcome! Before we begin, could you please share your *Name* and *Email ID*?\n\n" +
          "Example:\n*Name*: Your Name\n*Email*: name@gmail.com");
        session.step = 'collect_initial_details';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, "👋 To get started, please type *Hi*, *Hello*, or *Namaste*.");
      }
      break;

    case 'collect_initial_details': {
      const nameMatch = msgBody.match(/\*?name\*?\s*[:\-]?\s*(.*)/i);
      const emailMatch = msgBody.match(/\*?email\*?\s*[:\-]?\s*(.*)/i);

      let userName = nameMatch ? nameMatch[1].trim() : null;
      let userEmail = emailMatch ? emailMatch[1].trim() : null;

      // If either is missing, try extracting from plain lines
      if (!userName || !userEmail) {
        const lines = msgBody.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        lines.forEach(line => {
          if (!userEmail && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}$/i.test(line)) {
            userEmail = line;
          } else if (!userName && !line.toLowerCase().includes("@")) {
            userName = line.replace(/^name[:\-]?\s*/i, '').trim();
          }
        });
      }

      if (userName && userEmail) {
        session.userName = userName;
        session.userEmail = userEmail;
        session.userPhoneNumber = from;
        
        await sendMessage(phoneNumberId, from, `Thank you, *${session.userName}*!`);
        
        // Send client type buttons
        await sendWhatsAppMessage(phoneNumberId, {
          to: from,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: "🙏 Please tell us whether you are:" },
            action: {
              buttons: [
                { type: "reply", reply: { id: "new_client", title: "🆕 New Client" } },
                { type: "reply", reply: { id: "existing_client", title: "✅ Existing Client" } }
              ]
            }
          }
        });
        session.step = 'select_client_type';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Hmm.. Something isn't right.\n" +
          "Please provide your *Name* and *Email ID* correctly.\n\n" +
          "Example:\n*Name*: Your Name\n*Email*: name@gmail.com");
      }
      break;
    }

    case 'new_main_menu':
      if (msg.includes("mumbai")) {
        await sendMessage(phoneNumberId, from, 
          "🧘‍♀️ *Regular Weekday Batch*: \n\n" +
          "Morning Batch\nMonday to Friday\n" +
          "6:45 AM - 7:45 AM\n7:45 AM - 8:45 AM\n" +
          "8:45 AM - 9:45 AM\n10:30 AM - 11:30 AM\n\n" +
          "Evening Batch\n6:30 PM - 7:30 PM\n7:30 PM - 8:30 PM\n\n\n" +
          "🧘‍♀️ *Weekend Batch*: \n\nMorning Batch\nSaturday & Sunday\n7:00 AM - 8:15 AM\n\n\n" +
          "🧘‍♀️ *Aerial Yoga Batch*: \n\nMorning Batch\nSaturday & Sunday\n8:30 AM - 9:45 AM");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
        sessions.set(from, session);
      } else if (msg.includes("bangalore")) {
        await sendMessage(phoneNumberId, from, 
          "🧘‍♀️ *Regular Weekday Batch*: \n\n" +
          "Morning Batch\nMonday, Tuesday, Thursday, Friday\n" +
          "6:30 AM - 7:30 AM\n8:00 AM - 9:00 AM\n\n" +
          "Evening Batch\n7:00 PM - 8:00 PM\n\n\n" +
          "🧘‍♀️ *Meditation Batch*: \n\nMorning Batch\nSaturday only\n8:00 AM - 9:00 AM");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
        sessions.set(from, session);
      } else if (msg.includes("online")) {
        await sendMessage(phoneNumberId, from, 
          "🧘‍♀️ *Online Batch*: \n\n" +
          "Morning Batch\nMonday, Tuesday, Thursday, Friday\n" +
          "9:30 AM - 10:30 AM");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Hmm.. Something isn't right.\n" +
          "Please select your city from the menu below.");
        await welcomeNewCust(phoneNumberId, from, session.userName);
      }
      break;

    case 'main_menu':
      session.userCity = msgBody.trim();
      if (msg.includes("mumbai")) {
        await sendSelect(phoneNumberId, from);
        session.step = 'collect_user_query';
        sessions.set(from, session);
      } else if (msg.includes("bangalore")) {
        await sendSelect(phoneNumberId, from);
        session.step = 'collect_user_query';
        sessions.set(from, session);
      } else if (msg.includes("online")) {
        await sendSelect(phoneNumberId, from);
        session.step = 'collect_user_query';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Hmm.. Something isn't right.\n" +
          "Please select your city from the menu below.");
        await sendWelcome(phoneNumberId, from, session.userName);
      }
      break;

      case 'collect_user_query':
      if (msg.includes("refer")) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you so much for your referral!\n"+
          "Kindly provide the full name, phone number of the person you wish to refer.");
        session.step = 'collect_query_details';
        sessions.set(from, session);
      } else if (msg.includes("concern")) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you so much for reaching out!\n"+
          "You are one of our most valuable customers\n"+
          "Kindly provide the concern/complaint you wish to resolve!");
        session.step = 'collect_query_details';
        sessions.set(from, session);
      } else if (msg.includes("feedback")) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you so much for providing your feedback about us!\n"+
          "You are one of our most valuable customers\n"+
          "Kindly provide the honest feedback!");
        session.step = 'collect_query_details';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Hmm.. Something isn't right.\n" +
          "Please select your query from the menu below.");
        await sendSelect(phoneNumberId, from);
      }
      break;

    case 'collect_referral': {
      const query = msgBody.trim();

      if (query) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you so much! We've received your referral details. Our team will contact them shortly.");
        await sendYesNoButtons(phoneNumberId, from);

        // Notify the team
        const teamMessage = `New customer referral received:\n\n*Details*:\nName: ${session.userName}\nPhone Number: ${session.userPhoneNumber}\nEmail Id:${session.userEmail}\nCity: ${session.userCity}\nReferral Details:${query}`;
        await sendMessage(phoneNumberId, WHATSAPP_NUMBER, teamMessage);

        session.step = 'post_answer';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Please provide your referral details correctly.");
      }
      break;
    }

    case 'collect_concern': {
      const query = msgBody.trim();

      if (query) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you so much! We've received your concern/complaint. Our team is working on it.");
        await sendYesNoButtons(phoneNumberId, from);

        // Notify the team
        const teamMessage = `New customer concern/complaint received:\n\n*Details*:\nName: ${session.userName}\nPhone Number: ${session.userPhoneNumber}\nEmail Id:${session.userEmail}\nCity: ${session.userCity}\nConcern Details:${query}`;
        await sendMessage(phoneNumberId, WHATSAPP_NUMBER, teamMessage);

        session.step = 'post_answer';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Please provide your concern/complaint correctly.");
      }
      break;
    }

    case 'collect_feedback': {
      const query = msgBody.trim();

      if (query) {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you so much! We've received your honest feedback. This will help us grow as a community.");
        await sendYesNoButtons(phoneNumberId, from);

        // Notify the team
        const teamMessage = `New customer feedback received:\n\n*Details*:\nName: ${session.userName}\nPhone Number: ${session.userPhoneNumber}\nEmail Id:${session.userEmail}\nCity: ${session.userCity}\nFeedback Details:${query}`;
        await sendMessage(phoneNumberId, WHATSAPP_NUMBER, teamMessage);

        session.step = 'post_answer';
        sessions.set(from, session);
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Please provide your concern/complaint correctly.");
      }
      break;
    }

    case 'post_answer':
      if (msg === 'yes') {
        await sendWelcome(phoneNumberId, from, session.userName);
        session.step = 'main_menu';
        sessions.set(from, session);
      } else if (msg === 'no') {
        await sendMessage(phoneNumberId, from, 
          "Your wellness matters to us. Thanks for getting in touch with Shunyamudra Yoga & Wellness Center.");
        sessions.delete(from);
      } else {
        await sendMessage(phoneNumberId, from, "Would you like more assistance?");
        await sendYesNoButtons(phoneNumberId, from);
      }
      break;
    
    case 'post_answer_detail':
      if (msg === 'yes') {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you so much! Your booking request has been registered. Our team will contact you shortly.");
        await sendYesNoButtons(phoneNumberId, from);

        // Notify the team
        const teamMessage = `New customer demo booking request received:\n\n*Details*:\nName: ${session.userName}\nPhone Number: ${session.userPhoneNumber}\nEmail Id:${session.userEmail}\nCity: ${session.userCity}`;
        await sendMessage(phoneNumberId, WHATSAPP_NUMBER, teamMessage);

        session.step = 'post_answer';
        sessions.set(from, session);
      } else {
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
        sessions.set(from, session);
      }
      break;

    default:
      await sendWelcome(phoneNumberId, from, session.userName);
      session.step = 'main_menu';
      sessions.set(from, session);
      break;
  }
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
    throw err;
  }
}

async function sendMessage(phoneNumberId, to, text) {
  await sendWhatsAppMessage(phoneNumberId, { 
    to, 
    text: { body: text }, 
    type: 'text' 
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
async function sendWelcome(phoneNumberId, to, userName = '') {
  const greeting = userName ? `Hi ${userName} ` : '';
  await sendListMessage(phoneNumberId, to, 
    `🙏 ✨ ${greeting}Welcome to Shunyamudra service chatbot!\n\n` +
    "Let's begin your journey. Please tap one of the options below:", 
    "City", [
    { id: "mumbai", title: "Mumbai" },
    { id: "bangalore", title: "Bangalore" },
    { id: "online", title: "Online" }
  ]);
}

async function sendSelect(phoneNumberId, to, userName = '') {
  const greeting = userName ? `Hi ${userName} ` : '';
  await sendListMessage(phoneNumberId, to, 
    "🙏 ✨ Please tap one of the options below:", 
    "Main Menu", [
    { id: "refer_a_friend", title: "Refer a friend" },
    { id: "raise_concern", title: "Raise a concern" },
    { id: "feedback", title: "Provide feedback" }
  ]);
}

async function welcomeNewCust(phoneNumberId, to, userName = '') {
  const greeting = userName ? `Hi ${userName} ` : '';
  await sendListMessage(phoneNumberId, to, 
    `🙏 ✨ ${greeting}Welcome to Shunyamudra Yoga & Wellness Center!\n\n` +
    "Let's begin your journey. Please select your city from below:", 
    "City", [
    { id: "mumbai", title: "Mumbai" },
    { id: "bangalore", title: "Bangalore" },
    { id: "online", title: "Online" }
  ]);
}

async function sendClassTypeOptions(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, 
    "🧘 We offer regular offline and online batches including:\n" +
    "- Aerial Yoga\n- Meditation", 
    "Choose a Class Type", [
    { id: "class_regular_mum", title: "Regular Batch-Mumbai" },
    { id: "class_aerial", title: "Aerial Batch-Mumbai" },
    { id: "class_regular_blr", title: "Regular Batch-Bangalore" },
    { id: "class_meditation", title: "Meditation-Bangalore" },
    { id: "class_online", title: "Online Batch" }
  ]);
}

async function sendFeeDetails(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to, 
    "🧘 We are located in Kharghar, Navi Mumbai and Whitefield, Bangalore", 
    "Choose a Location", [
    { id: "kharghar", title: "Kharghar, Navi Mumbai" },
    { id: "whitefield", title: "Whitefield, Bangalore" },
    { id: "online", title: "Online Class" }
  ]);
}

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});