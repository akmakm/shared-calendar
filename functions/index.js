import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { GoogleGenAI } from "@google/genai";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
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
    const { question, language = 'en' } = req.body;
    if (!question) {
        logger.warn("Hybrid Search rejected: Missing question in request body.");
        return res.status(400).json({ error: "Missing question" });
    }

    try {
        logger.info("=== HYBRID SEARCH REQUEST RECEIVED ===", { question, language });

        // 1. Fetch all documents from Firestore faq_knowledge_base
        const snapshot = await db.collection("faq_knowledge_base").get();
        logger.info(`Scanned ${snapshot.size} documents in faq_knowledge_base.`);

        let bestMatch = null;
        let highestScore = 0;
        const CONFIDENCE_THRESHOLD = 0.6; // 60% keyword match requirement

        snapshot.forEach(doc => {
            const data = doc.data();
            const score = calculateConfidence(question, data.question || "");
            if (score > highestScore) {
                highestScore = score;
                bestMatch = { id: doc.id, ...data };
            }
        });

        // 2. If confident match found in Firestore, increment display_count and return it directly
        if (bestMatch && highestScore >= CONFIDENCE_THRESHOLD) {
            logger.info("High-confidence match found in Firestore FAQ", {
                matchId: bestMatch.id,
                score: highestScore,
                previousDisplayCount: bestMatch.display_count || 0
            });

            // Atomically increment display_count (initializes to 1 if missing)
            await db.collection("faq_knowledge_base").doc(bestMatch.id).update({
                display_count: FieldValue.increment(1),
                last_displayed_at: FieldValue.serverTimestamp()
            });

            logger.info(`Incremented display_count for FAQ document [${bestMatch.id}]`);

            return res.status(200).json({
                answer: bestMatch.answer,
                source: bestMatch.source || bestMatch.sourceUrl || null,
                matchType: "database",
                confidence: highestScore
            });
        }

        // 3. Otherwise, fall back to AI search generator
        logger.info("Low confidence or no match in Firestore. Falling back to AI search.", {
            highestScore,
            closestMatchId: bestMatch?.id || null
        });

        const aiResult = await generateAiAnswer(question, language);

        logger.info("AI fallback completed successfully.", { hasSource: !!aiResult.source });

        return res.status(200).json({
            answer: aiResult.answer,
            source: aiResult.source || null,
            matchType: "ai_fallback"
        });

    } catch (error) {
        logger.error("CRITICAL ERROR in hybrid search endpoint:", {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return res.status(500).json({ answer: "Internal server error during search.", source: null });
    }
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
// List of Admin PSIDs authorized to submit new FAQ pairs
const ADMIN_PSIDS = [
    "29472827892312783", // Alexander Kartomin's PSID
];

app.post('/messenger-webhook', async (req, res) => {
    const body = req.body;
    const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

    logger.info("=== WEBHOOK REQUEST RECEIVED ===", { 
        object: body.object,
        entryCount: body.entry?.length || 0 
    });

    try {
        if (body.object === 'page') {
            for (const entry of body.entry) {
                if (!entry.messaging || !entry.messaging[0]) continue;

                const webhookEvent = entry.messaging[0];
                const senderPsid = webhookEvent.sender?.id;
                const messageObj = webhookEvent.message;

                if (!messageObj || messageObj.is_echo || !senderPsid) {
                    logger.info("Skipping event: Echo message, missing message object, or missing sender ID.", { senderPsid, isEcho: messageObj?.is_echo });
                    continue;
                }

                const isAdmin = ADMIN_PSIDS.includes(senderPsid);
                const messageText = (messageObj.text || "").trim();
                const hasAttachments = Array.isArray(messageObj.attachments) && messageObj.attachments.length > 0;
                const adminPendingRef = db.collection('admin_pending_faq').doc(senderPsid);

                logger.info("Parsed Incoming Message", { 
                    senderPsid, 
                    isAdmin, 
                    hasAttachments, 
                    messageTextLength: messageText.length,
                    rawText: messageText 
                });

                if (isAdmin) {
                    const pendingDoc = await adminPendingRef.get();
                    logger.info("Checked pending FAQ state for admin", { exists: pendingDoc.exists, data: pendingDoc.exists ? pendingDoc.data() : null });

                    // CASE A: Admin already shared an attachment without text, now sending the Answer
                    if (pendingDoc.exists && pendingDoc.data().stage === 'awaiting_answer' && messageText) {
                        logger.info("Admin matched CASE A: Received answer text for pending attachment.");
                        
                        await adminPendingRef.set({
                            stage: 'awaiting_question',
                            answer: messageText,
                            timestamp: FieldValue.serverTimestamp()
                        });

                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: "💡 Answer recorded! Now reply with the question text to save it to the FAQ." }
                        });
                        
                        logger.info("Successfully sent reply for CASE A.");
                        continue;
                    }

                    // CASE B: Step 2 — Answer is saved, admin is now sending the Question text
                    if (pendingDoc.exists && pendingDoc.data().stage === 'awaiting_question' && messageText) {
                        logger.info("Admin matched CASE B: Received question text. Finalizing FAQ entry.");
                        
                        const answerText = pendingDoc.data().answer;

                        const newFaqRef = await db.collection("faq_knowledge_base").add({
                            question: messageText,
                            answer: answerText,
                            source: "Facebook Native Share",
                            createdBy: senderPsid,
                            timestamp: FieldValue.serverTimestamp()
                        });

                        logger.info(`Successfully written FAQ to Firestore with ID: ${newFaqRef.id}`);

                        await adminPendingRef.delete();
                        logger.info("Cleaned up pending FAQ document.");

                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: `✅ FAQ Saved!\n\n📌 Q: ${messageText}\n💡 A: ${answerText}\n🆔 ID: ${newFaqRef.id}` }
                        });

                        logger.info("Successfully sent confirmation for CASE B.");
                        continue;
                    }

                    // CASE C: Step 1 — Admin shared a post with attachment + answer in the same event
                    if (hasAttachments && messageText) {
                        logger.info("Admin matched CASE C: Received attachment + answer text simultaneously.");

                        await adminPendingRef.set({
                            stage: 'awaiting_question',
                            answer: messageText,
                            timestamp: FieldValue.serverTimestamp()
                        });

                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: "💡 Answer recorded! Now reply with the question text to save it to the FAQ." }
                        });

                        logger.info("Successfully sent prompt for CASE C.");
                        continue;
                    }

                    // CASE D: Step 1 (Split event) — Admin shared a post, attachment arrived first without text
                    if (hasAttachments && !messageText) {
                        logger.info("Admin matched CASE D: Received attachment without text. Setting awaiting_answer stage.");

                        await adminPendingRef.set({
                            stage: 'awaiting_answer',
                            timestamp: FieldValue.serverTimestamp()
                        });
                        continue;
                    }
                }

                // STANDARD QUERY FLOW (Regular users, or Admin asking a normal question without sharing)
                if (messageText) {
                    logger.info("Routing message to standard AI query handler.", { senderPsid, isAdmin });

                    const result = await generateAiAnswer(messageText, null);
                    let replyText = result.answer;
                    if (result.source) replyText += `\n\n🔗 ${result.source}`;

                    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                        recipient: { id: senderPsid },
                        message: { text: replyText }
                    });

                    logger.info("Successfully sent AI response to user.");
                }
            }
        }
    } catch (error) {
        logger.error("CRITICAL ERROR processing Messenger webhook:", {
            errorMessage: error.message,
            errorStack: error.stack,
            responseData: error.response?.data
        });
    }

    logger.info("=== WEBHOOK PROCESSING COMPLETE. SENDING 200 OK ===");
    res.status(200).send('EVENT_RECEIVED');
});

// Export the Express app as a 2nd-gen Firebase Cloud Function with Secrets enabled
export const askFaq = onRequest({ 
    secrets: [geminiApiKey, fbPageAccessToken, fbVerifyToken] 
}, app);
