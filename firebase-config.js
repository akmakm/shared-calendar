// Centralized Firebase Configuration using 5anque / ptanque-pal project
const firebaseConfig = {
    apiKey: "YOUR_RESTRICTED_API_KEY_HERE",
    projectId: "ptanque-pal",
    storageBucket: "ptanque-pal.firebasestorage.app"
};

// Initialize Firebase App & Firestore Database Instance
firebase.initializeApp(firebaseConfig);
export const db = firebase.firestore();
