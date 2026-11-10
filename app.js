import { db } from "./firebase-config.js";

let visitDocRef = null;

// Fetch IP-based location and log visit with region/address details
fetch('https://ipapi.co/json/')
    .then(response => response.json())
    .catch(() => ({})) // Fallback if blocked by adblock or network error
    .then(geoData => {
        return db.collection("page_visits").add({
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            userAgent: navigator.userAgent,
            language: navigator.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            screenResolution: `${window.screen.width}x${window.screen.height}`,
            referrer: document.referrer || "direct",
            url: window.location.href,
            ipAddress: geoData.ip || "unknown",
            country: geoData.country_name || "unknown",
            region: geoData.region || "unknown",
            city: geoData.city || "unknown",
            postalCode: geoData.postal || "unknown",
            calendarOpened: "Bulgaria (cal1)",
            calendarSwitches: []
        });
    })
    .then(docRef => {
        if (docRef) visitDocRef = docRef;
    })
    .catch(err => {
        console.error("Error recording visit to Firestore: ", err);
    });

// --- Calendar Google IDs ---
const calendars = {
    cal1: "c_40badfc66bb08e57ff6be29b6a3350909bec136dd4ac957c0cae51b87ab41291@group.calendar.google.com",
    cal2: "c_999755f1a46e47b62759bc0652928fe68deb0d75cd7241b11c38cc43123808cc@group.calendar.google.com"
};

let activeCalKey = 'cal1';
let initialLoad = true;

function updateTabTitle() {
    const headingText = document.getElementById('main-heading').innerText;
    const icon = (activeCalKey === 'cal1') ? '🇧🇬' : '🌐';
    document.title = `${icon} ${headingText}`;
}

// Expose switchCalendar globally for HTML onclick attributes
window.switchCalendar = function(calKey) {
    const calName = (calKey === 'cal1') ? "Bulgaria (cal1)" : "World (cal2)";

    if (!initialLoad && visitDocRef) {
        visitDocRef.update({
            lastOpenedCalendar: calName,
            calendarSwitches: firebase.firestore.FieldValue.arrayUnion({
                calendar: calName,
                time: new Date().toISOString()
            })
        }).catch(err => console.error("Error updating active calendar in Firestore: ", err));
    }

    activeCalKey = calKey;

    document.getElementById('btn-cal-1').classList.toggle('active', calKey === 'cal1');
    document.getElementById('btn-cal-2').classList.toggle('active', calKey === 'cal2');

    const calId = calendars[calKey];
    const encodedId = encodeURIComponent(calId);

    const googleUrl = `https://calendar.google.com/calendar/render?cid=${encodedId}`;
    const webcalUrl = `webcal://calendar.google.com/calendar/ical/${encodedId}/public/basic.ics`;
    const icsUrl = `https://calendar.google.com/calendar/ical/${encodedId}/public/basic.ics`;
    
    const calColor = (calKey === 'cal1') ? '%230D7813' : '%232952A3';
    const embedUrl = `https://calendar.google.com/calendar/embed?src=${encodedId}&ctz=Europe%2FSofia&wkst=2&color=${calColor}`;

    document.getElementById('link-google').href = googleUrl;
    document.getElementById('link-webcal').href = webcalUrl;
    document.getElementById('link-ics').href = icsUrl;
    document.getElementById('calendar-iframe').src = embedUrl;

    document.getElementById('qr-google').innerHTML = "";
    document.getElementById('qr-webcal').innerHTML = "";
    document.getElementById('qr-ics').innerHTML = "";

    new QRCode(document.getElementById("qr-google"), { text: googleUrl, width: 120, height: 120 });
    new QRCode(document.getElementById("qr-webcal"), { text: webcalUrl, width: 120, height: 120 });
    new QRCode(document.getElementById("qr-ics"), { text: icsUrl, width: 120, height: 120 });

    updateTabTitle();
    initialLoad = false;
};

function renderPageQr() {
    const currentUrl = window.location.href;
    document.getElementById('qr-page').innerHTML = "";
    new QRCode(document.getElementById("qr-page"), { text: currentUrl, width: 120, height: 120 });
}

// Expose copyPageLink globally for HTML onclick attributes
window.copyPageLink = function() {
    const dummy = document.createElement('input');
    document.body.appendChild(dummy);
    dummy.value = window.location.href;
    dummy.select();
    document.execCommand('copy');
    document.body.removeChild(dummy);

    const btn = document.getElementById('btn-copy-page');
    const origText = btn.innerText;
    const lang = document.documentElement.lang;
    
    btn.innerText = (lang === 'fr') ? "Lien copié !" : 
                    (lang === 'bg') ? "Копирано!" : 
                    (lang === 'sr') ? "Линк је копиран!" : 
                    (lang === 'de') ? "Link kopiert!" :
                    (lang === 'hu') ? "Link másolva!" :
                    (lang === 'el') ? "Ο σύνδεσμος αντιγράφηκε!" : "Copied!";
                    
    setTimeout(() => { btn.innerText = origText; }, 2000);
};

// Translations dictionary
const translations = {
    fr: {
        title: "Petanque Tournaments en Bulgarie - S'abonner et Synchroniser",
        mainHeading: "Petanque Tournaments en Bulgarie",
        subHeading: "Abonnez-vous pour synchroniser automatiquement les événements sur votre téléphone ou ordinateur.",
        card1Title: "Google Agenda",
        card1Desc: "Ajoutez directement à votre compte Google personnel en un clic.",
        card1Btn: "Ajouter à Google",
        card2Title: "Apple & Outlook (Synchro Live)",
        card2Desc: "Synchronisez nativement sur iOS, macOS ou Outlook via un lien iCal.",
        card2Btn: "S'abonner (iCal)",
        card3Title: "Télécharger le fichier .ICS",
        card3Desc: "Téléchargez un fichier statique pour importer manuellement.",
        card3Btn: "Télécharger .ICS",
        card4Title: "Partager cette page",
        card4Desc: "Scannez le QR code ou copiez le lien pour ouvrir cette page sur votre téléphone.",
        card4Btn: "Copier le lien",
        previewTitle: "Aperçu en direct",
        footerText: "Page d'accès partagé du calendrier"
    },
    en: {
        title: "Petanque Tournaments in Bulgaria - Subscribe and Synchronise",
        mainHeading: "Petanque Tournaments in Bulgaria",
        subHeading: "Subscribe to automatically sync events to your phone or computer.",
        card1Title: "Google Calendar",
        card1Desc: "Add directly to your personal Google account with one click.",
        card1Btn: "Add to Google",
        card2Title: "Apple & Outlook (Live Sync)",
        card2Desc: "Auto-sync natively to iOS, macOS, or Outlook via iCal link.",
        card2Btn: "Subscribe (iCal)",
        card3Title: "Download .ICS File",
        card3Desc: "Download a static file to import events manually into other apps.",
        card3Btn: "Download .ICS",
        card4Title: "Share This Page",
        card4Desc: "Scan the QR code or copy the link to open this landing page on your mobile device.",
        card4Btn: "Copy Page Link",
        previewTitle: "Live preview",
        footerText: "Shared calendar access page"
    },
    bg: {
        title: "Петанк Турнири в България - Абониране и Синхронизиране",
        mainHeading: "Петанк Турнири в България",
        subHeading: "Абонирайте се, за да поддържате събитията автоматично синхронизирани на телефона или компютъра си.",
        card1Title: "Google Календар",
        card1Desc: "Добавете директно към личния си Google профил с едно кликване.",
        card1Btn: "Добави в Google",
        card2Title: "Apple & Outlook (На живо)",
        card2Desc: "Автоматично синхронизиране за iOS, macOS или Outlook чрез iCal връзка.",
        card2Btn: "Абониране (iCal)",
        card3Title: "Изтегляне на .ICS файл",
        card3Desc: "Изтеглете статичен файл за ръчно импортиране в друг софтуер.",
        card3Btn: "Изтегляне .ICS",
        card4Title: "Споделете тази страница",
        card4Desc: "Сканирайте QR кода или копирайте линка, за да отворите страницата на телефон.",
        card4Btn: "Копирай линка",
        previewTitle: "Преглед на живо",
        footerText: "Страница за споделен достъп до календари"
    },
    sr: {
        title: "Петанк Турнири у Бугарској - Претплата и Синк",
        mainHeading: "Петанк Турнири у Бугарској",
        subHeading: "Претплатите се да аутоматизовано синкронизујете догађаје на вашем телефону или рачунару.",
        card1Title: "Google Календар",
        card1Desc: "Додајте директно у ваш лични Google налог једним кликом.",
        card1Btn: "Додај у Google",
        card2Title: "Apple & Outlook (Уживо)",
        card2Desc: "Аутоматско синкронизовање за iOS, macOS или Outlook преко iCal везе.",
        card2Btn: "Претплати се (iCal)",
        card3Title: "Преузимање .ICS фајла",
        card3Desc: "Преузмите статичну датотеку за ручни увоз у други софтвер.",
        card3Btn: "Преузми .ICS",
        card4Title: "Подели ову страницу",
        card4Desc: "Скенирајте QR код или копирајте везу да отворите страницу на мобилном.",
        card4Btn: "Копирај везу",
        previewTitle: "Преглед уживо",
        footerText: "Страница за дељени приступ календарима"
    },
    de: {
        title: "Pétanque-Turniere in Bulgarien - Abonnieren und Synchronisieren",
        mainHeading: "Pétanque-Turniere in Bulgarien",
        subHeading: "Abonnieren Sie, um Termine automatisch auf Ihrem Smartphone oder Computer zu synchronisieren.",
        card1Title: "Google Kalender",
        card1Desc: "Mit einem Klick direkt zu Ihrem persönlichen Google-Konto hinzufügen.",
        card1Btn: "Zu Google hinzufügen",
        card2Title: "Apple & Outlook (Live-Sync)",
        card2Desc: "Automatische Synchronisierung mit iOS, macOS oder Outlook über einen iCal-Link.",
        card2Btn: "Abonnieren (iCal)",
        card3Title: ".ICS-Datei herunterladen",
        card3Desc: "Laden Sie eine statische Datei herunter, um Termine manuell in andere Apps zu importieren.",
        card3Btn: ".ICS herunterladen",
        card4Title: "Diese Seite teilen",
        card4Desc: "Scannen Sie den QR-Code oder kopieren Sie den Link, um diese Seite auf Ihrem Mobilgerät zu öffnen.",
        card4Btn: "Link kopieren",
        previewTitle: "Live-Vorschau",
        footerText: "Seite für den geteilten Kalenderzugriff"
    },
    hu: {
        title: "Petanque versenyek Bulgáriában - Feliratkozás és szinkronizálás",
        mainHeading: "Petanque versenyek Bulgáriában",
        subHeading: "Iratkozzon fel, hogy az események automatikusan szinkronizálódjanak telefonjára vagy számítógépére.",
        card1Title: "Google Naptár",
        card1Desc: "Adja hozzá közvetlenül a személyes Google-fiókjához egy kattintással.",
        card1Btn: "Hozzáadás a Google-hoz",
        card2Title: "Apple & Outlook (Élő szinkron)",
        card2Desc: "Automatikus szinkronizálás iOS, macOS vagy Outlook rendszerekkel iCal linken keresztül.",
        card2Btn: "Feliratkozás (iCal)",
        card3Title: ".ICS fájl letöltése",
        card3Desc: "Töltsön le egy statikus fájlt az események kézi importálásához más alkalmazásokba.",
        card3Btn: ".ICS letöltése",
        card4Title: "Oldal megosztása",
        card4Desc: "Olvassa be a QR-kódot vagy másolja ki a linket az oldal mobileszközön való megnyitásához.",
        card4Btn: "Link másolása",
        previewTitle: "Élő előnézet",
        footerText: "Megosztott naptár hozzáférési oldal"
    },
    el: {
        title: "Τουρνουά Πετάνκ στη Βουλγαρία - Εγγραφή και Συγχρονισμός",
        mainHeading: "Τουρνουά Πετάνκ στη Βουλγαρία",
        subHeading: "Εγγραφείτε για να συγχρονίζετε αυτόματα τα γεγονότα στο κινητό ή στον υπολογιστή σας.",
        card1Title: "Ημερολόγιο Google",
        card1Desc: "Προσθήκη απευθείας στον προσωπικό σας λογαριασμό Google με ένα κλικ.",
        card1Btn: "Προσθήκη στο Google",
        card2Title: "Apple & Outlook (Ζωντανός συγχρονισμός)",
        card2Desc: "Αυτόματος συγχρονισμός σε iOS, macOS ή Outlook μέσω συνδέσμου iCal.",
        card2Btn: "Εγγραφή (iCal)",
        card3Title: "Λήψη αρχείου .ICS",
        card3Desc: "Κατεβάστε ένα στατικό αρχείο για μη αυτόματη εισαγωγή γεγονότων σε άλλες εφαρμογές.",
        card3Btn: "Λήψη .ICS",
        card4Title: "Κοινοποίηση αυτής της σελίδας",
        card4Desc: "Σαρώστε τον κωδικό QR ή αντιγράφηστε τον σύνδεσμο για να ανοίξετε αυτή τη σελίδα στη φορητή συσκευή σας.",
        card4Btn: "Αντιγραφή συνδέσμου",
        previewTitle: "Ζωντανή προεπισκόπηση",
        footerText: "Σελίδα κοινόχρηστης πρόσβασης ημερολογίου"
    }
};

// Application entry point when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const userLang = (navigator.language || navigator.userLanguage || 'en').substring(0, 2).toLowerCase();

    if (translations[userLang]) {
        const t = translations[userLang];
        document.getElementById('main-heading').innerText = t.mainHeading;
        document.getElementById('sub-heading').innerText = t.subHeading;
        
        document.getElementById('card1-title').innerText = t.card1Title;
        document.getElementById('card1-desc').innerText = t.card1Desc;
        document.getElementById('link-google').innerText = t.card1Btn;

        document.getElementById('card2-title').innerText = t.card2Title;
        document.getElementById('card2-desc').innerText = t.card2Desc;
        document.getElementById('link-webcal').innerText = t.card2Btn;

        document.getElementById('card3-title').innerText = t.card3Title;
        document.getElementById('card3-desc').innerText = t.card3Desc;
        document.getElementById('link-ics').innerText = t.card3Btn;

        document.getElementById('card4-title').innerText = t.card4Title;
        document.getElementById('card4-desc').innerText = t.card4Desc;
        document.getElementById('btn-copy-page').innerText = t.card4Btn;

        document.getElementById('preview-title').innerText = t.previewTitle;
        document.getElementById('footer-text').innerText = t.footerText;
        
        document.documentElement.setAttribute('lang', userLang);
    }

    switchCalendar('cal1');
    renderPageQr();
});
