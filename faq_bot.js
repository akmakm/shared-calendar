// Import Firebase modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, getDocs, doc, updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Your Firebase configuration (update with your project details if needed)
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    projectId: "5anque", // Using your 5anque project
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');

// Expose event handlers globally so inline HTML onclick attributes can reach them
window.handleKeyDown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        window.sendMessage();
    }
}

window.sendQuickPrompt = function(promptText) {
    userInput.value = promptText;
    window.sendMessage();
}

window.sendMessage = async function() {
    const text = userInput.value.trim();
    if (!text) return;

    appendMessage(text, 'user');
    userInput.value = '';
    chatMessages.scrollTop = chatMessages.scrollHeight;

    const loadingId = appendMessage("Searching knowledge base...", 'bot loading');

    try {
        const replyData = await findBestFaqMatch(text);
        document.getElementById(loadingId).remove();

        appendMessage(replyData.answer, 'bot');

        if (replyData.docId) {
            const docRef = doc(db, "faq_knowledge_base", replyData.docId);
            await updateDoc(docRef, {
                display_count: increment(1)
            });
            console.log(`Incremented display_count for document: ${replyData.docId}`);
        }
    } catch (error) {
        console.error("Error fetching FAQ from Firestore:", error);
        document.getElementById(loadingId).remove();
        appendMessage("Sorry, I encountered an issue connecting to the knowledge base. Please try again.", 'bot');
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

// Keyword-similarity scoring engine against Firestore FAQ documents
async function findBestFaqMatch(query) {
    const queryTokens = cleanAndTokenize(query);
    const querySnapshot = await getDocs(collection(db, "faq_knowledge_base"));
    
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
}

function cleanAndTokenize(text) {
    const stopWords = new Set(['is', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'of', 'how', 'what', 'do', 'i']);
    return text.toLowerCase()
               .replace(/[^\w\s]/gi, '')
               .split(/\s+/)
               .filter(word => word.length > 1 && !stopWords.has(word));
}
