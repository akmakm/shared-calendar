import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { GoogleGenAI } from "@google/genai";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const geminiApiKey = defineSecret("GEMINI_API_KEY");
if (!getApps().length) {
    initializeApp();
}
const db = getFirestore();

export const askFaq = onRequest({ secrets: [geminiApiKey] }, async (req, res) => {
    // Set explicit wildcard headers for cross-origin frontend requests
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "3600");

    // Handle preflight OPTIONS request immediately
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }

    if (req.method !== "POST") {
        res.status(405).json({ error: "Method Not Allowed" });
        return;
    }

    try {
        const { question, language } = req.body || {};
        if (!question) {
            res.status(400).json({ error: "Question is required." });
            return;
        }

        const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });

        logger.info(`Processing query: "${question}" in language: "${language || 'en'}"`);

        const snapshot = await db.collection("faq_knowledge_base").get();
        let docs = [];
        snapshot.forEach(doc => docs.push(doc.data()));
        // 1. Include sources clearly inside the context block
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
       Respond in the language specified by the language code: '${language || 'en'}'.

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
               responseMimeType: "application/json" // Enforces pure JSON output
           }
       });

       // 2. Parse the JSON response safely
       let result = { answer: chatResponse.text, source: null };
       try {
           result = JSON.parse(chatResponse.text);
       } catch (err) {
           logger.error("Failed to parse JSON response from Gemini", err);
       }

       // 3. Send to frontend (matches faq.html expectation)
       res.status(200).json({
           answer: result.answer,
           source: result.source
       });

    } catch (error) {
        logger.error("Error in askFaq function:", error);
        res.status(500).json({ error: "Failed to generate answer." });
    }
});

import express from "express";
import cors from "cors";
import axios from "axios";
import admin from "firebase-admin";
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

// --- Core Shared FAQ Handler (stub for your existing RAG/FAQ logic) ---
async function getFAQAnswer(questionText) {
    // Replace or connect this with your actual FAQ/AI processing function
    // Example: query your Firestore or vector search knowledge base
    return `Answer to: "${questionText}"`;
}

// ==========================================
// 1. WEB APP API ENDPOINT (faq.html)
// ==========================================
app.post('/', async (req, res) => {
    const questionText = req.body.question || req.body.text || "";
    if (!questionText.trim()) {
        return res.status(400).json({ error: "Question is required" });
    }

    const result = await getFAQAnswer(questionText);
    
    // Returns JSON containing both answer and source for faq.html
    res.json({
        answer: result.answer,
        source: result.source
    });
});

// ==========================================
// 3. FACEBOOK MESSENGER WEBHOOK ROUTES
// ==========================================
// Meta verification challenge (GET)
app.get('/messenger-webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
    
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Incoming messages handler (POST)
app.post('/messenger-webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;
    if (body.object === 'page') {
        for (let entry of body.entry) {
            const webhookEvent = entry.messaging[0];
            const senderPsid = webhookEvent.sender.id;

            if (webhookEvent.message && webhookEvent.message.text) {
                const userQuery = webhookEvent.message.text;
                const answer = await getFAQAnswer(userQuery);

                // Send reply back via Meta Graph API
                const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
                await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                    recipient: { id: senderPsid },
                    message: { text: answer }
                });
            }
        }
    }
});
