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

    let msgBody = message?.type === 'text'
      ? message.text.body.trim().toLowerCase()
      : message?.type === 'interactive'
        ? (message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.interactive?.list_reply?.id || '').toLowerCase()
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
  if (lowerCity.includes("mumbai") || lowerCity.includes("kharghar")) return "mumbai";
  if (lowerCity.includes("bangalore") || lowerCity.includes("whitefield")) return "bangalore";
  return "others";
}

function resetTimeout(phoneNumberId, from) {
  let session = sessions.get(from) || {};
  if (session) {
    clearAllTimeouts(session);
  }
  session.lastInteractionTime = Date.now();

  session.followUp1 = setTimeout(async () => {
    if (!sessions.has(from)) return;
    let session = sessions.get(from);
    session.step = 'followup_check_booking';
    sessions.set(from, session);

    await sendWhatsAppMessage(phoneNumberId, {
      to: from,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: "🙏 Have you booked the demo class?" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } }
          ]
        }
      }
    });

  }, 15 * 60 * 1000); // 12 hours

  session.followUp2 = setTimeout(async () => {
    if (!sessions.has(from)) return;

    let session = sessions.get(from);
    session.step = 'followup_check_booking';
    sessions.set(from, session);

    await sendWhatsAppMessage(phoneNumberId, {
      to: from,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: "🙏 Just checking again — have you booked the demo class?" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } }
          ]
        }
      }
    });

  }, 30 * 60 * 1000); // 24 hours

  session.finalTimeout = setTimeout(async () => {
    if (!sessions.has(from)) return;
    await sendMessage(phoneNumberId, from,
      "⏳ Session timed out.\n\nYour wellness matters to us. Thanks for connecting with *Shunyamudra Yoga & Wellness Center*.\n\nType *Hi* to restart."
    );
    sessions.delete(from);
  }, 35 * 60 * 1000); // 24 hours and five minutes

  sessions.set(from, session);
}

function clearAllTimeouts(session) {
  if (!session) return;

  if (session.followUp1) clearTimeout(session.followUp1);
  if (session.followUp2) clearTimeout(session.followUp2);
  if (session.finalTimeout) clearTimeout(session.finalTimeout);
}

function formatExtraInfo(text) {
  if (!text) return 'N/A';
  return text
    .replace(/[\s\n\r\t]+/g, '_')
    .replace(/_{5,}/g, '____')
    .trim();
}

async function notifyTeam(phoneNumberId, session, enquiry, extraInfo = '') {
  await sendTeamMessage(phoneNumberId, WHATSAPP_NUMBER, session, enquiry, extraInfo);
}

async function saveLead(phoneNumberId, session, enquiry, extraInfo = '') {
  await saveToGoogleSheets(session, enquiry, extraInfo);
}

// ==================== IMPROVED FLOW (FIXED) ====================
async function handleMessage(phoneNumberId, from, msgBody) {
  const msg = msgBody.toLowerCase().replace(/[?]/g, '').trim();
  const greetingKeywords = ["hi", "hello", "hey", "namaste", "namasthe"];
  const isGreeting = greetingKeywords.some(g => msg.startsWith(g));

  let session = sessions.get(from);

  // ❌ DO NOT reset timeout if user is in follow-up flow
  if (!session || !session.step?.startsWith('followup_')) {
    resetTimeout(phoneNumberId, from);
  }

  // Reset session on greeting
  if (!session || isGreeting) {
    if (session) {
      clearAllTimeouts(session);
      sessions.delete(from);
    }
    session = { step: 'ask_city', phoneNumberId, from };
    sessions.set(from, session);
  }

  switch (session.step) {
    case 'ask_city':
      if (isGreeting) {
        await sendSelectCity(phoneNumberId, from);
        session.step = 'collect_city';
      } else {
        await sendMessage(phoneNumberId, from, "👋 Type *Hi*, *Hello*, or *Namaste* to begin.");
      }
      break;

    // STEP 2: Collect city
    case 'collect_city':
      if (msg.includes("mumbai") || msg.includes("kharghar") || msg.includes("bangalore") || msg.includes("whitefield") || msg.includes("other") || msg.includes("online")) {
        session.userCity = msg;
        await showTimingsAndFeePreview(phoneNumberId, from, msg);
        await sendMessage(phoneNumberId, from, 
          "🙏 To know the *current offers* and *enrollment link*, please share:\n\n*Name*:\n*Email*:\n\nExample:\nName: John Doe\nEmail: john@example.com");
        session.step = 'collect_initial_details';
      } else {
        await sendMessage(phoneNumberId, from, "Please select a city from the options.");
        await sendSelectCity(phoneNumberId, from);
      }
      break;

    // STEP 3: Collect name + email
    case 'collect_initial_details':
      const { userName, userEmail } = extractUserDetails(msgBody);
      if (userName && userEmail) {
        Object.assign(session, { userName, userEmail, userPhoneNumber: from });
        await sendMessage(phoneNumberId, from, `Thank you, *${userName}!* 🧘‍♀️`);
        await giveCustomerOptions(phoneNumberId, from);
        session.step = 'customer_options';
      } else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Please provide *Name* and *Email* correctly as two lines in the below given format.\n\nExample:\nName: John Doe\nEmail: john@example.com");
      }
      break;

    // STEP 4: customer options
    case 'customer_options':
      if (msg.includes("talk")) {
        await sendMessage(phoneNumberId, from, "📞 Our trainer will call you shortly.");
        await notifyTeam(phoneNumberId, session, "Class Enquiry", "*Request*:Callback");
        await saveLead(phoneNumberId, session, "New Lead", "*Request*:Callback");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else if (msg.includes("page")) {
        await sendMessage(phoneNumberId, from, "📝 Register here: https://shunyamudra.com/register");
        await saveLead(phoneNumberId, session, "New Lead", "Registration Link shared, *Request*:Callback");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      }else if (msg.includes("explore")) {
        await checkCustomerStatus(phoneNumberId, from);
        session.step = 'check_status';
      }else {
        await sendMessage(phoneNumberId, from, 
          "⚠️ Please select a valid option.");
        await giveCustomerOptions(phoneNumberId, from);
      }
      break;

    // STEP 5: New or existing client
    case 'check_status':
      if (msg.includes("new")) {
        session.userStatus = 'new client';
        await sendClassMode(phoneNumberId, from);
        session.step = 'class_mode';
      } else if (msg.includes("existing")) {
        session.userStatus = 'existing client';
        await sendExistingWelcome(phoneNumberId, from);
        session.step = 'main_menu';
      } else {
        await checkCustomerStatus(phoneNumberId, from);
      }
      break;

    // STEP 6: Class mode (studio or personal)
    case 'class_mode':
      if (msg.includes("studio")) {
        await saveLead(phoneNumberId, session, "New Lead", "Group Class Enquiry, Request: Callback");
        await sendNewWelcome(phoneNumberId, from);
        session.step = 'main_menu';
      } else if (msg.includes("personal")) {
        const className = "Personal Class Enquiry";
        await sendMessage(phoneNumberId, from, "🙏 Thank you! Our team will contact you shortly for personal sessions.\n\nTo restart the chat please send a Hi anytime.");
        await saveLead(phoneNumberId, session, "New Lead", "Personal Class Enquiry, Request: Callback");
        await notifyTeam(phoneNumberId, session, className, `*Request*:${className}`);
        sessions.delete(from);
      } else {
        await sendMessage(phoneNumberId, from, "Please select a class mode.");
        await sendClassMode(phoneNumberId, from);
      }
      break;

    // STEP 7: Main menu for new clients
    case 'main_menu':
      if (msg.includes("timing") || msg.includes("class timings") || msg.includes("class_timings")) {
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
            "🧘‍♀️ *Meditation Batch*: \n\nMorning Batch\nSaturday only\n8:00 AM - 9:00 AM",
          others:
            "🧘‍♀️ *Batch times for Online class*: \n" +
            "Monday, Tuesday, Thursday, Friday\n" + 
            "9:30 AM - 10:30 AM"
        };
        const cityKey = extractCityKey(session.userCity);
        await sendMessage(phoneNumberId, from, cityTimings[cityKey]);
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } 
      else if (msg.includes("fee") || msg.includes("fee structure") || msg.includes("fee_structure")) {
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
            "🧘‍♀️ We recommend bringing your own yoga mat and a bottle of water for comfort & convenience.",
          others:
            "💰 Fee Details at Shunyamudra Yoga & Wellness Center - Online Batch\n" +
            "Weekday Batch: 2000/month"
        };
        const cityKey = extractCityKey(session.userCity);
        await sendMessage(phoneNumberId, from, cityFees[cityKey]);
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } 
      else if (msg.includes("join") || msg.includes("how to join") || msg.includes("how_to_join")) {
        await sendMessage(phoneNumberId, from, "📝 Register here: https://shunyamudra.com/register");
        await checkToCollectDetails(phoneNumberId, from);
        session.step = 'post_answer_detail';
      } 
      else if (msg.includes("talk") || msg.includes("trainer") || msg.includes("talk_to_person")) {
        await sendMessage(phoneNumberId, from, "📞 Our trainer will call you shortly.");
        await notifyTeam(phoneNumberId, session, "Class Enquiry", "*Request*:Callback");
        await saveLead(phoneNumberId, session, "New Lead", "*Request*:Callback");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } 
      else if (msg.includes("refer")) {
        await sendMessage(phoneNumberId, from, "👥 Thank you for your reference. Please share the name & phone number of the person you would like to refer.");
        session.step = 'collect_user_referral';
      } 
      else if (msg.includes("concern")) {
        await sendMessage(phoneNumberId, from, "📝 We are here for you. Please describe your concerns below.");
        session.step = 'collect_user_concern';
      } 
      else if (msg.includes("feedback")) {
        await sendMessage(phoneNumberId, from, "🌟 We’d love your feedback! Please write down your feedback.");
        session.step = 'collect_user_feedback';
      } 
      else {
        await sendNewWelcome(phoneNumberId, from);
      }
      break;
    
    // STEP 8: Collect Referral
    case 'collect_user_referral':
      if (msg.trim()) {
        const formattedMsg = formatExtraInfo(msg);
        await notifyTeam(phoneNumberId, session, "Referral", `*Referral*: ${formattedMsg}`);
        await saveLead(phoneNumberId, session, "Existing Client", `*Referral*: ${formattedMsg}`);
        await sendMessage(phoneNumberId, from, "🙏 Thank you! Our team will contact them soon.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide valid details.");
      }
      break;

    // STEP 9: Collect concerns
    case 'collect_user_concern':
      if (msg.trim()) {
        const formattedMsg = formatExtraInfo(msg);
        await notifyTeam(phoneNumberId, session, "Concern", `*Concern*: ${formattedMsg}`);
        await saveLead(phoneNumberId, session, "Existing Client", `*Concern*: ${formattedMsg}`);
        await sendMessage(phoneNumberId, from, "🙏 We’ve noted your concern. Our team is working to resolve it. In the meantime, you can call us directly at 7777016109 (12 PM - 4 PM) for urgent queries.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please describe your concern.");
      }
      break;

    // STEP 9: Collect feedback
    case 'collect_user_feedback':
      if (msg.trim()) {
        const formattedMsg = formatExtraInfo(msg);
        await notifyTeam(phoneNumberId, session, "Feedback", `*Feedback*: ${formattedMsg}`);
        await saveLead(phoneNumberId, session, "Existing Client", `*Feedback*: ${formattedMsg}`);
        await sendMessage(phoneNumberId, from, "🌟 Thank you for your feedback! It means a lot to us and helps us grow stronger.");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendMessage(phoneNumberId, from, "⚠️ Please provide valid feedback.");
      }
      break;

    // STEP 9: Further questions from Client
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
        await sendMessage(phoneNumberId, from, "🙏 Thank you for connecting with us! \n\nTo restart the chat please send a Hi anytime.");
        sessions.delete(from);
      } else {
        await sendYesNoButtons(phoneNumberId, from);
      }
      break;

    // STEP 10: Asking for Demo
    case 'post_answer_detail':
      if (msg === 'yes') {
        await sendMessage(phoneNumberId, from, "📞 Our trainer will call you shortly.");
        await notifyTeam(phoneNumberId, session, "Demo Enquiry", "*Request*:Callback");
        await saveLead(phoneNumberId, session, "New Lead", "*Request*:Callback");
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      } else {
        await sendYesNoButtons(phoneNumberId, from);
        session.step = 'post_answer';
      }
      break;

    case 'followup_check_booking':
      if (msg === 'yes') {
        await sendMessage(phoneNumberId, from, 
          "🙏 Thank you! Glad you booked the demo. Our trainer will connect with you.");

        clearAllTimeouts(session);
        sessions.delete(from); 
        return;
      } 
      else if (msg === 'no') {

        session.step = 'followup_offer_demo';
        sessions.set(from, session);

        await sendWhatsAppMessage(phoneNumberId, {
          to: from,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: "Would you like to book a demo class?" },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
                { type: 'reply', reply: { id: 'no', title: 'No' } }
              ]
            }
          }
        });

      } else {
        await sendMessage(phoneNumberId, from, "Please select Yes or No.");
      }
      break;
    
    case 'followup_offer_demo':
      if (msg === 'yes') {

        await sendMessage(phoneNumberId, from, 
          "📞 Great! Our trainer will contact you shortly.");

        await notifyTeam(phoneNumberId, session, "Follow-up Demo Enquiry", "*Request*: Callback");
        await saveLead(phoneNumberId, session, "Follow-up Demo Enquiry", "*Request*: Callback");

        clearAllTimeouts(session);
        sessions.delete(from); // Done, no more followups
        return;
      } 
      else if (msg === 'no') {

        await sendMessage(phoneNumberId, from, 
          "🙏 No worries! Feel free to reach out anytime.");

      } else {
        await sendMessage(phoneNumberId, from, "Please select Yes or No.");
      }
      break;

    default:
      await sendSelectCity(phoneNumberId, from);
      session.step = 'collect_city';
  }

  sessions.set(from, session);
}

// ==================== NEW HELPER: Show timings & fee preview ====================
async function showTimingsAndFeePreview(phoneNumberId, to, city) {
  let timingsText = "";
  let feeText = "";
  
  if (city.includes("mumbai") || city.includes("kharghar")) {
    timingsText = "⏰ *Mumbai (Kharghar)*: \nWeekday Morning 6:45 AM - 11:30 AM \nEvening 6:30 PM - 8:30 PM \nWeekend 7:00 AM - 8:15 AM";
    feeText = "💰 *Fee*: \nWeekday ₹2,500/month \nWeekend ₹2,000/month \nAerial ₹3,200/month";
  } 
  else if (city.includes("bangalore") || city.includes("whitefield")) {
    timingsText = "⏰ *Bangalore (Whitefield)*: \nWeekday Morning 6:30 AM - 9:00 AM \nEvening 7:00 PM - 8:00 PM \nMeditation Saturday 8:00 AM - 9:00 AM";
    feeText = "💰 *Fee*: \nWeekday ₹2,600/month \nMeditation ₹1,500/month";
  } 
  else {
    timingsText = "⏰ *Online*: 9:30 AM - 10:30 AM";
    feeText = "💰 *Fee*: ₹2,000/month";
  }
  
  await sendMessage(phoneNumberId, to, `🧘‍♀️ *Shunyamudra Yoga & Wellness Center*\n\n${timingsText}\n\n${feeText}\n\n✨ *Special offer*: Free Yoga mat if registered through Chatbot.`);
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

async function saveToGoogleSheets(session, enquiry, extraInfo) {
  try {
    await axios.post(process.env.GOOGLE_SHEET_WEBHOOK, {
      name: session.userName,
      phone: session.userPhoneNumber,
      email: session.userEmail,
      city: session.userCity,
      enquiry,
      extraInfo
    });
  } catch (err) {
    console.error("❌ Google Sheets Error:", err.message);
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
      name: 'team_notify',
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

async function giveCustomerOptions(phoneNumberId, to) {
  await sendWhatsAppMessage(phoneNumberId, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: "Would you like to" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'talk', title: 'Talk to our team' } },
          { type: 'reply', reply: { id: 'page', title: 'Enroll Now' } },
          { type: 'reply', reply: { id: 'explore', title: 'Explore more' } }
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
      body: { text: "Would you like to book a Demo class?" },
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
async function sendSelectCity(phoneNumberId, to) {
  await sendListMessage(phoneNumberId, to,
    "🙏 Namaste 🙏 Welcome to Shunyamudra Yoga & Wellness.\nWe have classes in Bangalore and Mumbai.\n\nWhich city are you from?",
    "Select your city",
    [
      { id: "mumbai", title: "Kharghar, Mumbai" },
      { id: "bangalore", title: "Whitefield, Bangalore" },
      { id: "others", title: "Other Location (Online)" }
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