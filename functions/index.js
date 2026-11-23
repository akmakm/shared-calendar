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
        //const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
// 1. Generate embedding using the exact same model used to populate faq_knowledge_base
async function getEmbedding(text) {
    //const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.embedContent({
        model: "models/gemini-embedding-001",
        contents: text.trim(),
        config: {
            outputDimensionality: 768,
            taskType: "RETRIEVAL_DOCUMENT"
        }
    });

    const embeddingValues =
        response.embedding?.values ||
        response.embeddings?.[0]?.values;

    if (!embeddingValues || !Array.isArray(embeddingValues)) {
        throw new Error("Failed to extract embedding values from Gemini response.");
    }

    return embeddingValues;
}

// 2. Cosine similarity between two numeric arrays
function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
        logger.warn("Vector dimension mismatch or invalid array", {
            lenA: vecA?.length,
            lenB: vecB?.length
        });
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 3. Shared RAG search + display_count increment + AI fallback
async function searchFaqWithRag(question, language = null, forceAi = false) {
    const SIMILARITY_THRESHOLD = 0.76;

    // Bypass KB lookup if user explicitly clicked "Ask Gemini"
    if (forceAi) {
        logger.info("Bypassing KB search (user requested Ask Gemini).", { question, language });
        const aiResult = await generateAiAnswer(question, language);
        return {
            answer: aiResult.answer,
            source: aiResult.source || null,
            matchType: "ai_fallback",
            docId: null,
            similarity: null,
            confidence: null
        };
    }

    let queryToEmbed = question;

    if (language !== 'en') {
        try {
            const sourceHint = (language && language !== 'auto') ? `from [${language}] ` : '';
            const translationResult = await ai.models.generateContent({
                model: 'gemini-flash-lite-latest',
                contents: `Translate the following petanque-related question ${sourceHint}to English. If already English, return as-is. Output ONLY the English text:\n\n"${question}"`
            });
            const rawText = typeof translationResult.text === 'function'
                ? translationResult.text()
                : (translationResult.text ?? translationResult.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
            const translated = rawText.trim().replace(/^["']|["']$/g, '');
            if (typeof translated === 'string' && translated.length > 0) {
                queryToEmbed = translated;
            }
        } catch (transError) {
            logger.warn("Query translation failed.", { errorMessage: transError.message });
        }
    }

    const queryEmbedding = await getEmbedding(queryToEmbed);
    const snapshot = await db.collection("faq_knowledge_base").get();

    let bestMatch = null;
    let highestSimilarity = -1;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        if (!Array.isArray(data.embedding) || data.embedding.length === 0) continue;

        const similarity = cosineSimilarity(queryEmbedding, data.embedding);
        if (similarity > highestSimilarity) {
            highestSimilarity = similarity;
            bestMatch = { id: doc.id, ...data };
        }
    }

    const confidencePct = highestSimilarity > 0
        ? `${(highestSimilarity * 100).toFixed(1)}%`
        : "0.0%";

    // Match >= 76%: return KB answer WITHOUT incrementing display_count yet
    if (bestMatch && highestSimilarity >= SIMILARITY_THRESHOLD) {
        logger.info(`KB match [${bestMatch.id}] at ${confidencePct}. Awaiting user feedback.`);
        return {
            answer: bestMatch.answer,
            source: bestMatch.source || bestMatch.sourceUrl || null,
            matchType: "rag_database",
            docId: bestMatch.id,
            similarity: highestSimilarity,
            confidence: confidencePct
        };
    }

    // Below 76%: immediately fall back to Gemini general knowledge
    logger.info(`No KB match >= 76% (top: ${confidencePct}). Proceeding directly to Gemini.`);
    const aiResult = await generateAiAnswer(question, language);

    return {
        answer: aiResult.answer,
        source: aiResult.source || null,
        matchType: "ai_fallback",
        docId: null,
        similarity: highestSimilarity,
        confidence: confidencePct
    };
}

// 4. Web UI endpoint (faq.html)
app.post('/', async (req, res) => {
    const { question, language, forceAi = false } = req.body;
    if (!question) {
        return res.status(400).json({ error: "Missing question" });
    }

    try {
        const result = await searchFaqWithRag(question, language || null, Boolean(forceAi));
        return res.status(200).json(result);
    } catch (error) {
        logger.error("Error in Web RAG search endpoint:", { errorMessage: error.message });
        return res.status(500).json({ answer: "Internal server error during search.", source: null });
    }
});

app.post('/feedback', async (req, res) => {
    const { docId } = req.body;
    if (!docId) {
        return res.status(400).json({ error: "Missing docId" });
    }

    try {
        await db.collection("faq_knowledge_base").doc(docId).update({
            display_count: FieldValue.increment(1),
            last_displayed_at: FieldValue.serverTimestamp()
        });
        logger.info(`User confirmed good answer. Incremented display_count for [${docId}].`);
        return res.status(200).json({ success: true });
    } catch (error) {
        logger.error("Error updating feedback display_count:", { docId, errorMessage: error.message });
        return res.status(500).json({ error: "Failed to record feedback" });
    }
});

// 5. Messenger Webhook endpoint (Two-step Admin FAQ ingestion + RAG query)
const ADMIN_PSIDS = [
    "29472827892312783", // Alexander Kartomin's PSID[cite: 1]
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
                    logger.info("Skipping event: Echo message, missing message object, or missing sender ID.", {
                        senderPsid,
                        isEcho: messageObj?.is_echo
                    });
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
    const pendingData = pendingDoc.exists ? pendingDoc.data() : null;
    const SIMILARITY_THRESHOLD = 0.88;

    logger.info("Checked pending FAQ state for admin", { exists: pendingDoc.exists, stage: pendingData?.stage });

    // Helper to send Messenger replies cleanly
    const replyToAdmin = async (text) => {
        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderPsid },
            message: { text }
        });
    };

    // STAGE 0: No pending state -> Admin sent a new proposed Answer
    if (!pendingDoc.exists && messageText) {
        logger.info("Admin provided a new proposed answer. Scanning KB for top match...");

        const proposedEmbedding = await getEmbedding(messageText);
        const snapshot = await db.collection("faq_knowledge_base").get();

        let topMatch = null;
        let highestSim = -1;

        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (Array.isArray(data.embedding) && data.embedding.length > 0) {
                const sim = cosineSimilarity(proposedEmbedding, data.embedding);
                if (sim > highestSim) {
                    highestSim = sim;
                    topMatch = { id: doc.id, ...data };
                }
            }
        }

        const confidencePct = topMatch ? (highestSim * 100).toFixed(1) : "0.0";
        const thresholdPct = (SIMILARITY_THRESHOLD * 100).toFixed(1);
        const isAssumedMatch = topMatch && highestSim >= SIMILARITY_THRESHOLD;

        await adminPendingRef.set({
            stage: 'awaiting_decision',
            answer: messageText,
            embedding: proposedEmbedding,
            matchedDocId: topMatch ? topMatch.id : null,
            timestamp: FieldValue.serverTimestamp()
        });

        let summaryMsg;
        if (topMatch) {
            const statusLabel = isAssumedMatch ? "⚠️ ASSUMED MATCH" : "ℹ️ NO CONFIDENT MATCH";
            summaryMsg =
                `${statusLabel}\n` +
                `📊 Confidence: ${confidencePct}% (Threshold: ${thresholdPct}%)\n\n` +
                `📌 Top Existing Q: "${topMatch.question}"\n` +
                `💡 Top Existing A: "${topMatch.answer}"\n` +
                `🆔 Doc ID: ${topMatch.id}\n\n` +
                `Choose an action:\n` +
                `• Reply **KEEP** to keep existing & cancel\n` +
                `• Reply **ADD** to save as a new record\n` +
                `• Reply **REPLACE** to overwrite this existing record`;
        } else {
            summaryMsg =
                `ℹ️ KB IS EMPTY (Confidence: 0.0% vs Threshold: ${thresholdPct}%)\n\n` +
                `Reply **ADD** to save as a new record, or **KEEP** to cancel.`;
        }

        await replyToAdmin(summaryMsg);
        continue;
    }

    // STAGE 1: Awaiting Decision (KEEP / ADD / REPLACE)
    if (pendingData && pendingData.stage === 'awaiting_decision' && messageText) {
        const choice = messageText.trim().toUpperCase();

        if (choice === 'KEEP') {
            logger.info("Admin chose KEEP. Aborting new entry.");
            await adminPendingRef.delete();
            await replyToAdmin("✅ Kept existing record. Recording cancelled.");
            continue;
        }

        if (choice === 'ADD' || (choice === 'REPLACE' && pendingData.matchedDocId)) {
            const actionMode = choice.toLowerCase(); // 'add' or 'replace'
            logger.info(`Admin chose ${choice}. Moving to source link stage.`);

            await adminPendingRef.update({
                stage: 'awaiting_source_link',
                actionMode,
                timestamp: FieldValue.serverTimestamp()
            });

            await replyToAdmin(
                `👍 Mode: **${choice}**.\n\n` +
                `Now reply with:\n` +
                `• A **source URL**\n` +
                `• **none** to save without a source link\n` +
                `• **stop** to cancel recording`
            );
            continue;
        }

        // Invalid command or REPLACE when KB was empty
        await replyToAdmin(
            pendingData.matchedDocId
                ? "❓ Please reply with **KEEP**, **ADD**, or **REPLACE**."
                : "❓ No existing record to replace. Please reply with **ADD** or **KEEP**."
        );
        continue;
    }

    // STAGE 2: Awaiting Source Link (URL / 'none' / 'stop')
    if (pendingData && pendingData.stage === 'awaiting_source_link' && messageText) {
        const trimmedInput = messageText.trim();
        const lowerInput = trimmedInput.toLowerCase();

        if (lowerInput === 'stop') {
            logger.info("Admin chose STOP during source link stage. Aborting.");
            await adminPendingRef.delete();
            await replyToAdmin("🛑 Recording stopped. No changes were saved.");
            continue;
        }

        const sourceLink = lowerInput === 'none' ? null : trimmedInput;
        logger.info("Admin provided source link choice.", { sourceLink });

        await adminPendingRef.update({
            stage: 'awaiting_question',
            sourceUrl: sourceLink,
            timestamp: FieldValue.serverTimestamp()
        });

        await replyToAdmin(
            `📌 Source: ${sourceLink || 'None'}.\n\n` +
            `Finally, reply with the **question text** to finalize and save (or **stop** to cancel).`
        );
        continue;
    }

    // STAGE 3: Awaiting Question Text -> Commit ADD or REPLACE to Firestore
    if (pendingData && pendingData.stage === 'awaiting_question' && messageText) {
        const trimmedQuestion = messageText.trim();

        if (trimmedQuestion.toLowerCase() === 'stop') {
            logger.info("Admin chose STOP during question stage. Aborting.");
            await adminPendingRef.delete();
            await replyToAdmin("🛑 Recording stopped. No changes were saved.");
            continue;
        }

        const payload = {
            question: trimmedQuestion,
            answer: pendingData.answer,
            embedding: pendingData.embedding,
            source: pendingData.sourceUrl || null,
            updatedBy: senderPsid,
            timestamp: FieldValue.serverTimestamp()
        };

        let savedDocId;

        if (pendingData.actionMode === 'replace' && pendingData.matchedDocId) {
            savedDocId = pendingData.matchedDocId;
            await db.collection("faq_knowledge_base").doc(savedDocId).update(payload);
            logger.info(`Replaced existing FAQ document: ${savedDocId}`);
        } else {
            const newFaqRef = await db.collection("faq_knowledge_base").add({
                ...payload,
                display_count: 0,
                createdBy: senderPsid
            });
            savedDocId = newFaqRef.id;
            logger.info(`Added new FAQ document: ${savedDocId}`);
        }

        await adminPendingRef.delete();

        await replyToAdmin(
            `✅ FAQ ${pendingData.actionMode === 'replace' ? 'Replaced' : 'Added'} Successfully!\n\n` +
            `📌 Q: ${trimmedQuestion}\n` +
            `💡 A: ${pendingData.answer}\n` +
            `🔗 Source: ${pendingData.sourceUrl || 'None'}\n` +
            `🆔 ID: ${savedDocId}`
        );
        continue;
    }
}

                // STANDARD QUERY FLOW (Uses shared RAG vector search + display_count increment)
if (messageText) {
    const result = await searchFaqWithRag(messageText, null, false);

    if (result.matchType === "rag_database" && result.docId) {
        let replyText = `${result.answer}\n\n📊 Match: ${result.confidence}`;
        if (result.source) replyText += `\n🔗 ${result.source}`;

        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderPsid },
            message: {
                text: replyText,
                quick_replies: [
                    {
                        content_type: "text",
                        title: "👍 Good answer",
                        payload: JSON.stringify({ action: "GOOD_ANSWER", docId: result.docId })
                    },
                    {
                        content_type: "text",
                        title: "👎 Ask Gemini",
                        payload: JSON.stringify({ action: "ASK_GEMINI", question: messageText })
                    }
                ]
            }
        });
    } else {
        // Below 76%: already fell back to Gemini directly
        let replyText = result.answer;
        if (result.source) replyText += `\n\n🔗 ${result.source}`;

        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderPsid },
            message: { text: replyText }
        });
    }
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
