# Voice Healthcare Assistant

A lightweight voice and text medical note extractor using browser speech recognition and Google Gemini.

## Setup

1. Open a terminal in `backend/`
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in `backend/` using `backend/.env.example`:
   ```text
   GOOGLE_API_KEY=your-google-api-key-here
   ```
4. Start the server:
   ```bash
   npm start
   ```

## Usage

- Open `http://localhost:3000` in a browser.
- Use the **Start Speaking** button to capture voice notes.
- Or paste notes into the manual text area and click **Analyze Manual Text**.
- The extracted medical fields are shown instantly and saved to local history.

## Notes

- Use Chrome or Edge for the best speech recognition support.
- If speech recognition is unavailable, use manual text input.
- The backend serves the frontend directly, so you do not need to open `index.html` as a file.

## Project structure

- `backend/server.js` — Express server, static frontend hosting, and Gemini processing.
- `frontend/index.html` — UI with voice, manual text input, and history.
- `frontend/script.js` — client logic for recording, analysis, and local history.
- `frontend/style.css` — responsive styling.
