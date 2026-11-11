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

// --- ADMIN PSID LIST ---
// Replace with your actual PSID (found in Cloud Logs when you send a message)
const ADMIN_PSIDS = [
    "29472827892312783", // Alexander Kartomin's PSID for this Page
    // Add additional admin PSIDs here as needed
];

// Helper: Extract URLs/Links from message text or attachments
function extractSharedLink(messageObj) {
    let sharedLink = null;

    // Check attachments (Facebook Shares usually come as fallback/share attachments)
    if (messageObj.attachments && messageObj.attachments.length > 0) {
        for (let att of messageObj.attachments) {
            if (att.payload && att.payload.url) {
                sharedLink = att.payload.url;
                break;
            }
        }
    }

    // Fallback: Check if message text contains an explicit http/https URL
    if (!sharedLink && messageObj.text) {
        const urlMatch = messageObj.text.match(/(https?:\/\/[^\s]+)/g);
        if (urlMatch && urlMatch.length > 0) {
            sharedLink = urlMatch[0];
        }
    }

    return sharedLink;
}

// Helper: Search Firestore FAQ collection for a match
async function findFaqMatch(queryText) {
    if (!queryText) return null;
    
    // Clean query text (remove link from text if present)
    const cleanQuery = queryText.replace(/(https?:\/\/[^\s]+)/g, '').trim().toLowerCase();

    const snapshot = await db.collection("faq_knowledge_base").get();
    let bestMatch = null;

    snapshot.forEach(doc => {
        const data = doc.data();
        const q = (data.question || "").toLowerCase();
        
        // Exact match or primary substring match
        if (cleanQuery && (q.includes(cleanQuery) || cleanQuery.includes(q))) {
            bestMatch = { id: doc.id, ...data };
        }
    });

    return bestMatch;
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

                const sharedLink = extractSharedLink(messageObj);
                const isAdmin = ADMIN_PSIDS.includes(senderPsid);

                logger.info(`Messenger event from PSID ${senderPsid} | IsAdmin: ${isAdmin} | SharedLink: ${sharedLink || 'None'}`);

                // =========================================================
                // CONDITION: Both Admin & Shared Link are present
                // =========================================================
                if (isAdmin && sharedLink) {
                    const userQuery = messageObj.text || "";
                    const faqMatch = await findFaqMatch(userQuery);

                    const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

                    if (faqMatch) {
                        // MATCH FOUND: Respond with answer="found" and corresponding link/source
                        const responseText = `answer="found"\nLink: ${faqMatch.source || faqMatch.url || 'No link attached to FAQ entry'}`;
                        
                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: responseText }
                        });
                        
                        logger.info(`Admin forward matched FAQ [${faqMatch.id}] for PSID ${senderPsid}`);
                    } else {
                        // NOT FOUND: Record in Firestore under 'unmatched_forwarded_links'
                        await db.collection("unmatched_forwarded_links").add({
                            senderPsid: senderPsid,
                            sharedLink: sharedLink,
                            originalText: userQuery,
                            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                            status: "pending_review"
                        });

                        const responseText = `No FAQ match found. The forwarded link has been recorded for review.`;
                        
                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: responseText }
                        });

                        logger.info(`Admin forward recorded in unmatched_forwarded_links for PSID ${senderPsid}`);
                    }
                } 
                // =========================================================
                // STANDARD BOT HANDLING (Non-admin or regular message)
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
