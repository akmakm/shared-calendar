import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { GoogleGenAI } from "@google/genai";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import express from "express";
import cors from "cors";
import axios from "axios";

// Initialize Firebase Admin
if (!getApps().length) {
    initializeApp();
}
const db = getFirestore();

// Define Gemini API Key Secret
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const fbPageAccessToken = defineSecret("FB_PAGE_ACCESS_TOKEN");
const fbVerifyToken = defineSecret("FB_VERIFY_TOKEN");

const app = express();

// Enable CORS for your domain and local development
app.use(cors({
    origin: [
        'https://petanque.kartomin.com',
        'https://petanque-pal.web.app',
        'https://petanque-pal.firebaseapp.com',
        'http://localhost:5000',
        'http://localhost:3000'
    ]
}));
app.use(express.json());

// --- Core AI Answer Generator (Shared by Web API & Messenger) ---
async function generateAiAnswer(question, requestedLanguage = null) {
    try {
        const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });

        logger.info(`Processing query: "${question}" | Requested language: "${requestedLanguage || 'auto-detect'}"`);

        const snapshot = await db.collection("faq_knowledge_base").get();
        let docs = [];
        snapshot.forEach(doc => docs.push(doc.data()));

        const contextText = docs.map((d, index) => 
            `[Item ${index + 1}]
            Question: ${d.question}
            Answer: ${d.answer}
            Source: ${d.source || 'None'}`
       ).join("\n\n");

       // Tell Gemini to respond in the requested language, or match the user's language automatically
       const languageInstruction = requestedLanguage 
           ? `Respond in the language specified by code: '${requestedLanguage}'.`
           : `Detect the language of the User Question and respond in that EXACT same language.`;

       const prompt = `You are an official Petanque FAQ assistant.
Use the context below to answer the question.
Select the exact Source URL from the matching FAQ context item if available. If no specific source applies, return null for source.
If the answer cannot be found in the context, use your general knowledge about Petanque rules, and then select for source a relevant URL.
${languageInstruction}

Context:
${contextText}

User Question: ${question}

Return your response strictly as a JSON object with this format:
{
  "answer": "Your detailed answer here...",
  "source": "https://..." or null
}`;

       const chatResponse = await ai.models.generateContent({
           model: "gemini-flash-lite-latest",
           contents: prompt,
           config: {
               responseMimeType: "application/json"
           }
       });

       let result = { answer: chatResponse.text, source: null };
       try {
           result = JSON.parse(chatResponse.text);
       } catch (err) {
           logger.error("Failed to parse JSON response from Gemini", err);
       }

       return {
           answer: result.answer,
           source: result.source
       };

    } catch (error) {
        logger.error("Error generating AI answer:", error);
        return {
            answer: "Sorry, I encountered an error connecting to the AI knowledge base.",
            source: null
        };
    }
}

// ==========================================
// 1. WEB APP API ENDPOINT (faq.html)
// ==========================================
app.post('/', async (req, res) => {
    const questionText = req.body.question || req.body.text || "";
    const language = req.body.language || 'en';

    // Log web request
    logger.info("Web API request received", { question: questionText, language });

    if (!questionText.trim()) {
        return res.status(400).json({ error: "Question is required" });
    }

    const result = await generateAiAnswer(questionText, language);
    
    res.json({
        answer: result.answer,
        source: result.source
    });
});

// ==========================================
// 2. FACEBOOK MESSENGER WEBHOOK ROUTES
// ==========================================
app.get('/messenger-webhook', (req, res) => {
    logger.info("Messenger webhook verification GET request received");

    const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
        logger.info("Messenger webhook verification successful");
        res.status(200).send(challenge);
    } else {
        logger.warn("Messenger webhook verification failed: token mismatch or missing mode");
        res.sendStatus(403);
    }
});

const axios = require('axios');

// List of Admin PSIDs authorized to submit new FAQ pairs
const ADMIN_PSIDS = [
    "29472827892312783", // Alexander Kartomin's PSID
];

// Helper: Extract shared URL and clean text from incoming Messenger payload
function parseAdminMessage(messageObj) {
    let sharedLink = null;
    let fallbackTitle = "";

    // 1. Check for shared attachments (Messenger share/fallback payload)
    if (messageObj.attachments && messageObj.attachments.length > 0) {
        for (let att of messageObj.attachments) {
            if (att.payload && att.payload.url) {
                sharedLink = att.payload.url;
            }
            if (att.title) {
                fallbackTitle = att.title;
            }
        }
    }

    // 2. Check text for URL fallback
    if (!sharedLink && messageObj.text) {
        const match = messageObj.text.match(/(https?:\/\/[^\s]+)/g);
        if (match) sharedLink = match[0];
    }

    // 3. Extract admin's answer text (removing the raw URL if embedded in text)
    let adminAnswer = (messageObj.text || "").replace(/(https?:\/\/[^\s]+)/g, '').trim();

    return { sharedLink, adminAnswer, fallbackTitle };
}

// Helper: Attempt to fetch post content/question text via Facebook Graph API
async function fetchPostContent(sharedLink, fallbackTitle) {
    const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

    // Try extracting numeric post ID from standard FB URLs (e.g., posts/123456789 or fbid=123456789)
    const postIdMatch = sharedLink ? sharedLink.match(/(?:posts|permalink|story_fbid|v)=?\/?:?([0-9_]+)/) : null;
    
    if (postIdMatch && postIdMatch[1]) {
        try {
            const postId = postIdMatch[1];
            const graphRes = await axios.get(`https://graph.facebook.com/v18.0/${postId}`, {
                params: {
                    fields: 'message,story',
                    access_token: PAGE_ACCESS_TOKEN
                }
            });
            if (graphRes.data && (graphRes.data.message || graphRes.data.story)) {
                return graphRes.data.message || graphRes.data.story;
            }
        } catch (err) {
            logger.warn("Could not fetch post details via Graph API, falling back to attachment metadata", err.message);
        }
    }

    // Fallback to attachment title if Graph API lookup is restricted by group privacy
    return fallbackTitle || "Question from shared post";
}

// --- Messenger Webhook Endpoint ---
app.post('/messenger-webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;
    if (body.object === 'page') {
        for (let entry of body.entry) {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0];
                const senderPsid = webhookEvent.sender.id;
                const messageObj = webhookEvent.message;

                if (!messageObj) continue;

                const isAdmin = ADMIN_PSIDS.includes(senderPsid);
                const { sharedLink, adminAnswer, fallbackTitle } = parseAdminMessage(messageObj);

                // =========================================================
                // ADMIN PAIRING FLOW: Link + Admin Answer Text
                // =========================================================
                if (isAdmin && sharedLink) {
                    // Ensure the admin provided an answer along with the link
                    if (!adminAnswer) {
                        const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: "⚠️ Shared link received, but no answer text was included. Please send the link along with your answer in the same message." }
                        });
                        continue;
                    }

                    // 1. Get the Question text from the post
                    const questionText = await fetchPostContent(sharedLink, fallbackTitle);

                    // 2. Add directly to Firestore `faq_knowledge_base`
                    const newFaqRef = await db.collection("faq_knowledge_base").add({
                        question: questionText,
                        answer: adminAnswer,
                        source: sharedLink,
                        createdBy: senderPsid,
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // 3. Confirm back to Admin with details
                    const confirmText = `✅ Added to FAQ Knowledge Base!\n\n📌 Question: "${questionText}"\n💡 Answer: "${adminAnswer}"\n🔗 Source: ${sharedLink}\n🆔 Doc ID: ${newFaqRef.id}`;

                    const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
                    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                        recipient: { id: senderPsid },
                        message: { text: confirmText }
                    });

                    logger.info(`Admin ${senderPsid} saved new FAQ entry [${newFaqRef.id}]`);
                } 
                // =========================================================
                // STANDARD USER / NON-ADMIN QUERY FLOW
                // =========================================================
                else if (messageObj.text) {
                    const result = await generateAiAnswer(messageObj.text, null);
                    let replyText = result.answer;
                    if (result.source) replyText += `\n\n🔗 ${result.source}`;

                    const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
                    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                        recipient: { id: senderPsid },
                        message: { text: replyText }
                    });
                }
            }
        }
    }
});

// Export the Express app as a 2nd-gen Firebase Cloud Function with Secrets enabled
export const askFaq = onRequest({ 
    secrets: [geminiApiKey, fbPageAccessToken, fbVerifyToken] 
}, app);
