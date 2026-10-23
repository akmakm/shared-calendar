# Bulgaria & World Petanque Calendars

A responsive, multilingual landing page for sharing and synchronizing Google Calendars for petanque tournaments, featuring cross-platform export options and automated visitor analytics.

## 🚀 Key Features
* **Multilingual Interface**: Automatically detects browser language (Bulgarian, English, French, Serbian).
* **Dual Calendars**: Toggle seamlessly between Bulgarian and World tournament calendars.
* **Flexible Sync Options**: 
  * Direct one-click Google Calendar integration.
  * Live Webcal/iCal feeds for Apple and Outlook.
  * Static `.ICS` file downloads.
  * Instant QR codes for mobile sharing.
* **Visitor Analytics**: Automatically logs visitor telemetry and location data (`ipapi.co`) into **Firebase Firestore** (`page_visits`).

## 📁 Project Structure
* **`index.html`**: Main HTML structure and localization templates.
* **`style.css`**: Responsive styling, layout grids, and Bulgarian tricolor theme.
* **`app.js`**: Firebase initialization, geolocation tracking, and dynamic calendar controls.

## 🌐 Deployment
Hosted and deployed statically via **GitHub Pages**.
