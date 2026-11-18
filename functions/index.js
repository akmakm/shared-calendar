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
// 1. Generate embedding using the exact same model used to populate faq_knowledge_base
async function getEmbedding(text) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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
async function searchFaqWithRag(question, language = 'en') {
    const SIMILARITY_THRESHOLD = 0.86;
    const queryToEmbed = question;
    // Translate non-English input to English for robust vector matching against KB
    if (language && language !== 'en' && language !== 'auto') {
        try {
            logger.info(`Translating query from [${language}] to English for vector RAG search.`);
            const translationResult = await ai.models.generateContent({
                model: 'gemini-flash-lite-latest', // Or your standard text model
                contents: `Translate the following petanque-related question from [${language}] to English. Return ONLY the translated text, with no extra quotes, formatting, or commentary:\n\n"${question}"`
            });
            logger.info(`translationResult = [${translationResult.text}] `);
            const translated = translationResult.text ? translationResult.text.trim() : '';
            if (translated) {
                queryToEmbed = translated;
                logger.info(`Query successfully translated to English: "${queryToEmbed}"`);
            }
        } catch (transError) {
            logger.warn("Query translation failed. Falling back to original question text.", {
                errorMessage: transError.message
            });
        }
    }
    logger.info("=== RAG VECTOR SEARCH STARTED ===", { queryToEmbed, language });

    const queryEmbedding = await getEmbedding(queryToEmbed);
    logger.info("Generated query embedding", { dimensions: queryEmbedding.length });

    const snapshot = await db.collection("faq_knowledge_base").get();
    logger.info(`Loaded ${snapshot.size} documents from faq_knowledge_base.`);

    let bestMatch = null;
    let highestSimilarity = -1;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
            logger.warn(`Skipping FAQ doc [${doc.id}]: missing or empty embedding array.`);
            continue;
        }

        const similarity = cosineSimilarity(queryEmbedding, data.embedding);
        if (similarity > highestSimilarity) {
            highestSimilarity = similarity;
            bestMatch = { id: doc.id, ref: doc.ref, ...data };
        }
    }

    logger.info("RAG vector scan finished", {
        bestMatchId: bestMatch?.id || null,
        bestMatchQuestion: bestMatch?.question || null,
        highestSimilarity: Number(highestSimilarity.toFixed(4)),
        threshold: SIMILARITY_THRESHOLD
    });

    if (bestMatch && highestSimilarity >= SIMILARITY_THRESHOLD) {
        await bestMatch.ref.update({
            display_count: FieldValue.increment(1),
            last_displayed_at: FieldValue.serverTimestamp()
        });

        logger.info(`Confident RAG match [${bestMatch.id}]. Incremented display_count.`, {
            previousCount: bestMatch.display_count || 0
        });

        return {
            answer: bestMatch.answer,
            source: bestMatch.source || bestMatch.sourceUrl || null,
            matchType: "rag_database",
            similarity: highestSimilarity
        };
    }

    logger.info("No confident vector match in Firestore. Falling back to AI generation.", { highestSimilarity });
    const aiResult = await generateAiAnswer(question, language);

    return {
        answer: aiResult.answer,
        source: aiResult.source || null,
        matchType: "ai_fallback",
        similarity: highestSimilarity
    };
}

// 4. Web UI endpoint (faq.html)
app.post('/', async (req, res) => {
    const { question, language = 'en' } = req.body;
    if (!question) {
        logger.warn("Web search rejected: Missing question.");
        return res.status(400).json({ error: "Missing question" });
    }

    try {
        const result = await searchFaqWithRag(question, language);
        return res.status(200).json(result);
    } catch (error) {
        logger.error("CRITICAL ERROR in Web RAG search endpoint:", {
            errorMessage: error.message,
            errorStack: error.stack
        });
        return res.status(500).json({ answer: "Internal server error during search.", source: null });
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

    logger.info("Checked pending FAQ state for admin", { exists: pendingDoc.exists, data: pendingData });

    // STATE 0: No pending state exists. This incoming message is a NEW proposed Answer!
    if (!pendingDoc.exists && messageText) {
        logger.info("Admin provided a new proposed answer. Checking KB for duplicates...");

        // Generate embedding for the proposed answer
        const proposedEmbedding = await getEmbedding(messageText);

        // Check KB similarity against existing answer embeddings
        const snapshot = await db.collection("faq_knowledge_base").get();
        let mostSimilarMatch = null;
        let highestSim = -1;

        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (Array.isArray(data.embedding) && data.embedding.length > 0) {
                const sim = cosineSimilarity(proposedEmbedding, data.embedding);
                if (sim > highestSim) {
                    highestSim = sim;
                    mostSimilarMatch = { id: doc.id, ...data };
                }
            }
        }

        const SIMILARITY_THRESHOLD = 0.86;
        
        // If a similar answer already exists in KB, ask for FORCE confirmation
        if (mostSimilarMatch && highestSim >= SIMILARITY_THRESHOLD) {
            logger.info("Duplicate answer detected in KB", { matchId: mostSimilarMatch.id, similarity: highestSim });

            await adminPendingRef.set({
                stage: 'awaiting_force_confirmation',
                answer: messageText,
                embedding: proposedEmbedding,
                timestamp: FieldValue.serverTimestamp()
            });

            await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                recipient: { id: senderPsid },
                message: { text: `⚠️ **Similar Answer Exists in KB** (Similarity: ${(highestSim * 100).toFixed(1)}%)\n\nMatched Q: "${mostSimilarMatch.question}"\n\nReply **FORCE** to record it anyway, or send a different answer to start over.` }
            });
            continue;
        }

        // If absent, proceed to prompt for source link
        logger.info("Answer is unique. Proceeding to source link prompt.");
        await adminPendingRef.set({
            stage: 'awaiting_source_link',
            answer: messageText,
            embedding: proposedEmbedding,
            timestamp: FieldValue.serverTimestamp()
        });

        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderPsid },
            message: { text: "💡 Answer unique & recorded! Now reply with the **source link** (or type 'none' to skip)." }
        });
        continue;
    }

    // STATE 1: Awaiting Force Confirmation
    if (pendingData && pendingData.stage === 'awaiting_force_confirmation' && messageText) {
        if (messageText.toUpperCase() === 'FORCE') {
            logger.info("Admin forced recording of duplicate answer. Moving to source link stage.");

            await adminPendingRef.update({
                stage: 'awaiting_source_link',
                timestamp: FieldValue.serverTimestamp()
            });

            await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                recipient: { id: senderPsid },
                message: { text: "⚡ Force accepted! Now reply with the **source link** (or type 'none' to skip)." }
            });
        } else {
            logger.info("Admin declined force confirmation. Skipping record.");
            await adminPendingRef.delete();

            await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                recipient: { id: senderPsid },
                message: { text: "❌ Skipped recording. Send a new answer whenever you're ready." }
            });
        }
        continue;
    }

    // STATE 2: Awaiting Source Link
    if (pendingData && pendingData.stage === 'awaiting_source_link' && messageText) {
        logger.info("Admin provided source link.");

        const sourceLink = messageText.toLowerCase() === 'none' ? null : messageText;

        await adminPendingRef.update({
            stage: 'awaiting_question',
            sourceUrl: sourceLink,
            timestamp: FieldValue.serverTimestamp()
        });

        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderPsid },
            message: { text: "📌 Source link recorded! Finally, reply with the **question text** to save it to the FAQ." }
        });
        continue;
    }

    // STATE 3: Awaiting Question Text (Final Save)
    if (pendingData && pendingData.stage === 'awaiting_question' && messageText) {
        logger.info("Admin provided question text. Saving FAQ to Firestore.");

        const answerText = pendingData.answer;
        const answerEmbedding = pendingData.embedding;
        const sourceLink = pendingData.sourceUrl || null;

        const newFaqRef = await db.collection("faq_knowledge_base").add({
            question: messageText,
            answer: answerText,
            embedding: answerEmbedding,
            source: sourceLink || "Facebook Admin Share",
            display_count: 0,
            createdBy: senderPsid,
            timestamp: FieldValue.serverTimestamp()
        });

        logger.info(`Successfully written FAQ to Firestore with ID: ${newFaqRef.id}`);

        await adminPendingRef.delete();

        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderPsid },
            message: { text: `✅ FAQ Saved Successfully!\n\n📌 Q: ${messageText}\n💡 A: ${answerText}\n🔗 Source: ${sourceLink || 'None'}\n🆔 ID: ${newFaqRef.id}` }
        });
        continue;
    }
}

                // STANDARD QUERY FLOW (Uses shared RAG vector search + display_count increment)
                if (messageText) {
                    logger.info("Routing message to RAG search handler.", { senderPsid, isAdmin });

                    const result = await searchFaqWithRag(messageText, 'en');
                    let replyText = result.answer;
                    if (result.source) replyText += `\n\n🔗 ${result.source}`;

                    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                        recipient: { id: senderPsid },
                        message: { text: replyText }
                    });

                    logger.info("Successfully sent RAG/AI response to Messenger user.", { matchType: result.matchType });
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
