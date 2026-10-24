// Centralized Firebase Configuration using 5anque / ptanque-pal project
const firebaseConfig = {
    apiKey: "AIzaSyAXbL_1DO9T7gPba3VgfscTh2ymK87S7jU",
    projectId: "ptanque-pal",
    storageBucket: "ptanque-pal.firebasestorage.app"
};

// Initialize Firebase App & Firestore Database Instance
firebase.initializeApp(firebaseConfig);
export const db = firebase.firestore();
