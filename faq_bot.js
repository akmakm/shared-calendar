import { db } from "./firebase-config.js";

// Safe helper to fetch DOM elements dynamically when actions occur
function getElements_noAI() {
    return {
        chatMessages: document.getElementById('chat-messages'),
        userInput: document.getElementById('user-input')
    };
}

window.handleKeyDown_noAI = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        window.sendMessage_noAI();
    }
}

window.sendQuickPrompt_noAI = function(promptText) {
    logFaqError_noAI("sendQuickPrompt_noAI", "promptText=" + promptText);
    const { userInput } = getElements_noAI();
    if (!userInput) return;
    
    userInput.value = promptText;
    window.sendMessage_noAI();
}

window.sendMessage_noAI = async function() {
    const { chatMessages, userInput } = getElements_noAI();
    logFaqError_noAI("sendMessage_noAI", "userInput=" + userInput.value.trim());
    if (!userInput || !chatMessages) return;

    const text = userInput.value.trim();
    if (!text) return;

    appendMessage_noAI(text, 'user');
    userInput.value = '';
    chatMessages.scrollTop = chatMessages.scrollHeight;

    const loadingId = appendMessage_noAI("Searching knowledge base...", 'bot loading');

    try {
        const replyData = await findBestFaqMatch_noAI(text);
        
        const loadingElem = document.getElementById(loadingId);
        if (loadingElem) loadingElem.remove();

        // Pass the source URL if available so it renders as a clickable link
        appendMessage_noAI(replyData.answer, 'bot', replyData.source);

        // Increment display_count in /faq_knowledge_base
        if (replyData.docId) {
            await db.collection("faq_knowledge_base").doc(replyData.docId).update({
                display_count: firebase.firestore.FieldValue.increment(1)
            });
            console.log(`Incremented display_count for document: ${replyData.docId}`);
        }
    } catch (error) {
        console.error("Error fetching FAQ from Firestore:", error);
        const loadingElem = document.getElementById(loadingId);
        if (loadingElem) loadingElem.remove();
        
        appendMessage_noAI("Sorry, I encountered an issue connecting to the knowledge base. Please try again.", 'bot');

        // Log the actual error to the 'error_logs' Firestore collection
        logFaqError_noAI(error, { query: text, action: "sendMessage_noAI" });
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendMessage_noAI(content, sender, sourceUrl = null) {
    const { chatMessages } = getElements_noAI();
    if (!chatMessages) return null;

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender.includes('loading') ? 'bot' : sender}`;
    msgDiv.id = 'msg-' + Math.random().toString(36).substring(2, 9);

    // Safely assign text content to prevent XSS
    const textSpan = document.createElement('span');
    textSpan.textContent = content;
    msgDiv.appendChild(textSpan);

    // If a source URL exists, append a secure clickable link element
    if (sourceUrl && sourceUrl.trim() !== '') {
        const br = document.createElement('br');
        msgDiv.appendChild(br);

        const sourceLink = document.createElement('a');
        sourceLink.href = sourceUrl;
        sourceLink.textContent = '🔗 Source Reference';
        sourceLink.target = '_blank';
        sourceLink.rel = 'noopener noreferrer';
        sourceLink.style.display = 'inline-block';
        sourceLink.style.marginTop = '6px';
        sourceLink.style.fontSize = '0.85em';
        sourceLink.style.color = 'inherit';
        sourceLink.style.textDecoration = 'underline';
        
        msgDiv.appendChild(sourceLink);
    }

    chatMessages.appendChild(msgDiv);
    return msgDiv.id;
}

async function findBestFaqMatch_noAI(query) {
    try {
        const queryTokens = cleanAndTokenize_noAI(query);
        const querySnapshot = await db.collection("faq_knowledge_base").get();
        
        let bestMatch = {
            answer: "Thanks for your question! I couldn't find a direct match in our database. Try asking about cochonnet distances, scoring, or calendar sync.",
            source: null,
            docId: null,
            score: 0
        };

        querySnapshot.forEach((documentSnapshot) => {
            const data = documentSnapshot.data();
            const dbQuestion = data.question || "";
            const dbAnswer = data.answer || "";
            const dbSource = data.source || null;
            
            const targetTokens = new Set([...cleanAndTokenize_noAI(dbQuestion), ...cleanAndTokenize_noAI(dbAnswer)]);
            
            let matchScore = 0;
            queryTokens.forEach(token => {
                if (targetTokens.has(token)) {
                    matchScore += 1;
                }
            });

            if (matchScore > bestMatch.score) {
                bestMatch = {
                    answer: dbAnswer,
                    source: dbSource,
                    docId: documentSnapshot.id,
                    score: matchScore
                };
            }
        });

        if (bestMatch.score === 0) {
            return {
                answer: "I couldn't find a close match for that in our petanque knowledge base. Feel free to rephrase or check our quick prompts below!",
                source: null,
                docId: null
            };
        }

        return bestMatch;
    } catch (error) {
        logFaqError_noAI(error, { query, action: "findBestFaqMatch_noAI" });
        throw error;
    }
}

function cleanAndTokenize_noAI(text) {
    const stopWords = new Set(['is', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'of', 'how', 'what', 'do', 'i']);
    return text.toLowerCase()
               .replace(/[^\w\s]/gi, '')
               .split(/\s+/)
               .filter(word => word.length > 1 && !stopWords.has(word));
}

async function logFaqError_noAI(error, additionalContext = {}) {
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
