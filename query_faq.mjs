import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';

// 1. Validate environment configuration
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("❌ ERROR: GEMINI_API_KEY environment variable is missing!");
    process.exit(1);
}

// 2. Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(
    fs.readFileSync(new URL('./serviceAccountKey.json', import.meta.url))
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const ai = new GoogleGenAI({ apiKey });

/**
 * Mathematical helper: Calculate Cosine Similarity between two numeric vectors
 */
function cosineSimilarity(vecA, vecB) {
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

/**
 * 3. Main Component 2 Execution: Semantic Search + Structured Generation
 */
async function queryFAQ(userQuery) {
    console.log(`\n🔎 User Query: "${userQuery}"`);

    try {
        // Step A: Generate query embedding using RETRIEVAL_QUERY task type
        console.log("⏳ Generating query vector with gemini-embedding-001...");
        const embeddingResponse = await ai.models.embedContent({
            model: 'models/gemini-embedding-001',
            contents: userQuery,
            config: {
                taskType: 'RETRIEVAL_QUERY', // Optimized for search queries
                outputDimensionality: 768    // Matches Firestore document dimensions
            }
        });

        const queryVector = embeddingResponse.embedding?.values || embeddingResponse.embeddings?.[0]?.values;
        if (!queryVector) {
            throw new Error("Failed to generate embedding for the user query.");
        }

        // Step B: Fetch all FAQ documents from Firestore
        console.log("📚 Fetching knowledge base from Firestore...");
        const snapshot = await db.collection("faq_knowledge_base").get();
        
        if (snapshot.empty) {
            console.log("⚠️ Knowledge base is empty.");
            return;
        }

        // Step C: Compute Cosine Similarity for each document
        const scoredDocs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.embedding && Array.isArray(data.embedding)) {
                const score = cosineSimilarity(queryVector, data.embedding);
                scoredDocs.push({
                    id: doc.id,
                    question: data.question,
                    answer: data.answer,
                    score: score
                });
            }
        });

        // Sort descending by similarity score and pick the top 3 matches
        scoredDocs.sort((a, b) => b.score - a.score);
        const topMatches = scoredDocs.slice(0, 3);

        console.log(`🎯 Top matching documents found:`);
        topMatches.forEach((m, idx) => {
            console.log(`   [${idx + 1}] Score: ${m.score.toFixed(4)} | Q: ${m.question}`);
        });

        if (topMatches.length === 0 || topMatches[0].score < 0.4) {
            console.log("🤖 No sufficiently relevant matches found in the FAQ knowledge base.");
            return;
        }

        // Step D: Pass context to Gemini with Structured Outputs schema
        console.log("💬 Synthesizing response via Gemini LLM...");
        const contextString = topMatches
            .map(m => `Source ID: ${m.id}\nQuestion: ${m.question}\nAnswer: ${m.answer}`)
            .join("\n\n---\n\n");

        const prompt = `
You are a helpful customer support assistant. Answer the user's question using ONLY the provided FAQ context below. Provide confidence scores between 0.0 and 1.0 for your candidates.

User Question: "${userQuery}"

FAQ Context:
${contextString}
        `.trim();

        const generativeResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', // Or your preferred generative model
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        candidates: {
                            type: Type.ARRAY,
                            description: "List of matched answers addressing the query",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    answer: { type: Type.STRING, description: "The synthesized answer text" },
                                    confidence: { type: Type.NUMBER, description: "Confidence score between 0.0 and 1.0" },
                                    source_doc_id: { type: Type.STRING, description: "The Firestore source document ID" }
                                },
                                required: ["answer", "confidence", "source_doc_id"]
                            }
                        }
                    },
                    required: ["candidates"]
                }
            }
        });

        console.log("\n✨ Final Structured Response:");
        console.log(JSON.parse(generativeResponse.text));

    } catch (error) {
        console.error("❌ Error running query pipeline:", error);
    }
}

// Example test run
queryFAQ("How far away does the cochonnet need to be?");
