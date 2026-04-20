# Voice Healthcare Assistant

A lightweight voice and text medical note extractor using browser speech recognition and AI models (Groq or Google Gemini).

## Setup

1. **Install MySQL**: Ensure MySQL is installed and running on your system. You can download it from [mysql.com](https://dev.mysql.com/downloads/mysql/) or use a package manager like Homebrew (macOS), apt (Ubuntu), or Chocolatey (Windows).

2. **Create Database**: Create a MySQL database named `voice_health_db` (or update the `DB_NAME` in `.env`):
   ```sql
   CREATE DATABASE voice_health_db;
   ```

3. **Open a terminal in `backend/`**
4. **Install dependencies**:
   ```bash
   npm install
   ```
5. **Create a `.env` file in `backend/` using `backend/.env.example`**:
   - Copy `.env.example` to `.env`
   - Add your AI API key (Groq or Google)
   - Update MySQL credentials if needed:
     ```text
     DB_HOST=localhost
     DB_USER=root
     DB_PASSWORD=your_mysql_password
     DB_NAME=voice_health_db
     DB_PORT=3306
     ```
6. **Start the server**:
   ```bash
   npm start
   ```

## Usage

- Open `http://localhost:3000` in a browser.
- Use the **Start Speaking** button to capture voice notes in English, Hindi, or Marathi.
- Or paste notes into the manual text area and click **Analyze Manual Text**.
- The extracted medical fields (symptoms, diagnosis, prescription, etc.) are shown instantly and saved to the MySQL database.
- View patient history by entering a Patient ID.

## Features

- **Multilingual Support**: English, Hindi, Marathi speech recognition.
- **AI-Powered Extraction**: Extracts symptoms, diagnosis, medicines, BP, temperature, etc.
- **Patient Management**: Unique patient IDs with history tracking.
- **Database Storage**: MySQL for persistent data storage.
- **Fallback Parsing**: Local extraction if AI fails.

## Notes

- Use Chrome or Edge for the best speech recognition support.
- If speech recognition is unavailable, use manual text input.
- The backend serves the frontend directly, so you do not need to open `index.html` as a file.
- Ensure MySQL is running before starting the server.

## Project Structure

- `backend/server.js` — Express server, MySQL database, AI processing.
- `frontend/index.html` — UI with voice, manual text input, patient history.
- `frontend/script.js` — Client logic for recording, analysis, and history display.
- `frontend/style.css` — Responsive styling.
