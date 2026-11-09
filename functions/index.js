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
async function generateAiAnswer(question, language = 'en') {
    try {
        const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });

        logger.info(`Processing query: "${question}" in language: "${language}"`);

        const snapshot = await db.collection("faq_knowledge_base").get();
        let docs = [];
        snapshot.forEach(doc => docs.push(doc.data()));

        const contextText = docs.map((d, index) => 
            `[Item ${index + 1}]
            Question: ${d.question}
            Answer: ${d.answer}
            Source: ${d.source || 'None'}`
       ).join("\n\n");

       const prompt = `You are an official Petanque FAQ assistant.
Use the context below to answer the question.
Select the exact Source URL from the matching FAQ context item if available. If no specific source applies, return null for source.
If the answer cannot be found in the context, use your general knowledge about Petanque rules, and then select for source a relevant URL.
Respond in the language specified by the language code: '${language}'.

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

app.post('/messenger-webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;
    logger.info("Messenger webhook POST event received", { object: body.object });

    if (body.object === 'page') {
        for (let entry of body.entry) {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0];
                const senderPsid = webhookEvent.sender.id;

                if (webhookEvent.message && webhookEvent.message.text) {
                    const userQuery = webhookEvent.message.text;
                    logger.info(`Messenger message processed for sender ${senderPsid}`, { query: userQuery });

                    const result = await generateAiAnswer(userQuery, 'en');

                    let replyText = result.answer;
                    if (result.source) {
                        replyText += `\n\n🔗 Source: ${result.source}`;
                    }

                    const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
                    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                        recipient: { id: senderPsid },
                        message: { text: replyText }
                    });
                    logger.info(`Messenger reply successfully sent to sender ${senderPsid}`);
                }
            }
        }
    }
});

// Export the Express app as a 2nd-gen Firebase Cloud Function with Secrets enabled
export const askFaq = onRequest({ 
    secrets: [geminiApiKey, fbPageAccessToken, fbVerifyToken] 
}, app);
