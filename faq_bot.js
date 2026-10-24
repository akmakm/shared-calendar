import { db } from "./firebase-config.js";

const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');

window.handleKeyDown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        window.sendMessage();
    }
}

window.sendQuickPrompt = function(promptText) {
    logFaqError("sendQuickPrompt","promptText="+promptText);
    userInput.value = promptText;
    window.sendMessage();
}

window.sendMessage = async function() {
    const text = userInput.value.trim();
    logFaqError("sendMessage","text="+text);
    if (!text) return;

    appendMessage(text, 'user');
    userInput.value = '';
    chatMessages.scrollTop = chatMessages.scrollHeight;

    const loadingId = appendMessage("Searching knowledge base...", 'bot loading');

    try {
        const replyData = await findBestFaqMatch(text);
        document.getElementById(loadingId).remove();

        appendMessage(replyData.answer, 'bot');

        // Increment display_count in /faq_knowledge_base
        if (replyData.docId) {
            await db.collection("faq_knowledge_base").doc(replyData.docId).update({
                display_count: firebase.firestore.FieldValue.increment(1)
            });
            console.log(`Incremented display_count for document: ${replyData.docId}`);
        }
    } catch (error) {
        console.error("Error fetching FAQ from Firestore:", error);
        document.getElementById(loadingId).remove();
        appendMessage("Sorry, I encountered an issue connecting to the knowledge base. Please try again.", 'bot');

        // Log the error to the new 'error_logs' Firestore collection
        logFaqError(error, { query: text, action: "sendMessage" });
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendMessage(content, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender.includes('loading') ? 'bot' : sender}`;
    msgDiv.id = 'msg-' + Math.random().toString(36).substring(2, 9);
    msgDiv.textContent = content;
    chatMessages.appendChild(msgDiv);
    return msgDiv.id;
}

async function findBestFaqMatch(query) {
    try {
        const queryTokens = cleanAndTokenize(query);
        const querySnapshot = await db.collection("faq_knowledge_base").get();
        
        let bestMatch = {
            answer: "Thanks for your question! I couldn't find a direct match in our database. Try asking about cochonnet distances, scoring, or calendar sync.",
            docId: null,
            score: 0
        };

        querySnapshot.forEach((documentSnapshot) => {
            const data = documentSnapshot.data();
            const dbQuestion = data.question || "";
            const dbAnswer = data.answer || "";
            
            const targetTokens = new Set([...cleanAndTokenize(dbQuestion), ...cleanAndTokenize(dbAnswer)]);
            
            let matchScore = 0;
            queryTokens.forEach(token => {
                if (targetTokens.has(token)) {
                    matchScore += 1;
                }
            });

            if (matchScore > bestMatch.score) {
                bestMatch = {
                    answer: dbAnswer,
                    docId: documentSnapshot.id,
                    score: matchScore
                };
            }
        });

        if (bestMatch.score === 0) {
            return {
                answer: "I couldn't find a close match for that in our petanque knowledge base. Feel free to rephrase or check our quick prompts below!",
                docId: null
            };
        }

        return bestMatch;
    } catch (error) {
        // Log query matching errors specifically
        logFaqError(error, { query, action: "findBestFaqMatch" });
        throw error;
    }
}

function cleanAndTokenize(text) {
    const stopWords = new Set(['is', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'of', 'how', 'what', 'do', 'i']);
    return text.toLowerCase()
               .replace(/[^\w\s]/gi, '')
               .split(/\s+/)
               .filter(word => word.length > 1 && !stopWords.has(word));
}

// Dedicated helper to record exceptions into the 'error_logs' collection
async function logFaqError(error, additionalContext = {}) {
    try {
        await db.collection("error_logs").add({
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            errorMessage: error.message || String(error),
            errorStack: error.stack || "no stack trace available",
            userAgent: navigator.userAgent,
            url: window.location.href,
            context: additionalContext
        });
        console.log("Error successfully logged to Firestore collection 'error_logs'.");
    } catch (loggingErr) {
        console.error("Failed to write error log to Firestore:", loggingErr);
    }
}
