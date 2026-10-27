// query_faq.mjs
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI, Type } from '@google/genai';

// Hardcoded Gemini API Key
const GEMINI_API_KEY = "AQ.Ab8RN6LmVhXC3H_-1eBy9EuEGnGBpv9e2BF0NboFc65oRXU5YQ";

// Initialize Firebase Admin using Application Default Credentials (ADC)
// This looks for standard environment variables (like GOOGLE_APPLICATION_CREDENTIALS) 
// or cloud metadata automatically without needing a raw private key string.
if (!getApps().length) {
    initializeApp();
}

const db = getFirestore();
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
 * Searches the FAQ knowledge base semantically and returns structured candidates.
 */
export async function getSemanticAnswer(userQuery) {
    // 1. Generate query vector using RETRIEVAL_QUERY task type
    const embeddingResponse = await ai.models.embedContent({
        model: 'models/gemini-embedding-001',
        contents: userQuery,
        config: {
            taskType: 'RETRIEVAL_QUERY',
            outputDimensionality: 768
        }
    });

    const queryVector = embeddingResponse.embedding?.values || embeddingResponse.embeddings?.[0]?.values;
    if (!queryVector) {
        throw new Error("Failed to generate embedding for the query.");
    }

    // 2. Fetch documents from Firestore[cite: 1]
    const snapshot = await db.collection("faq_knowledge_base").get();
    if (snapshot.empty) return { candidates: [] };

    // 3. Compute Cosine Similarity
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

    scoredDocs.sort((a, b) => b.score - a.score);
    const topMatches = scoredDocs.slice(0, 3);

    if (topMatches.length === 0 || topMatches[0].score < 0.4) {
        return { candidates: [] };
    }

    // 4. Synthesize via Gemini Structured Outputs
    const contextString = topMatches
        .map(m => `Source ID: ${m.id}\nQuestion: ${m.question}\nAnswer: ${m.answer}`)
        .join("\n\n---\n\n");

    const prompt = `
You are a helpful customer support assistant. Answer the user's question using ONLY the provided FAQ context below. Provide confidence scores between 0.0 and 1.0.

User Question: "${userQuery}"

FAQ Context:
${contextString}
    `.trim();

    const generativeResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    candidates: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                answer: { type: Type.STRING },
                                confidence: { type: Type.NUMBER },
                                source_doc_id: { type: Type.STRING }
                            },
                            required: ["answer", "confidence", "source_doc_id"]
                        }
                    }
                },
                required: ["candidates"]
            }
        }
    });

    return JSON.parse(generativeResponse.text);
}
