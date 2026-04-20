import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import mysql from "mysql2/promise";
import crypto from "crypto";
import { fileURLToPath } from "url";
import multer from "multer";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = Number(process.env.PORT || 3000);
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const AI_PROVIDER = (process.env.AI_PROVIDER || (GROQ_API_KEY ? "groq" : "google")).toLowerCase();
const API_KEY = AI_PROVIDER === "groq" ? GROQ_API_KEY : GOOGLE_API_KEY;
const API_BASE_URL = AI_PROVIDER === "groq"
  ? process.env.GROQ_API_BASE_URL || "https://api.groq.com/openai/v1"
  : process.env.GOOGLE_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta2";
const MODEL_NAME = AI_PROVIDER === "groq"
  ? process.env.GROQ_MODEL || "llama-3.1-8b-instant"
  : process.env.GOOGLE_MODEL || "text-bison-001";
const MODEL_METHOD = AI_PROVIDER === "google"
  ? MODEL_NAME.startsWith("chat-")
    ? "generateMessage"
    : MODEL_NAME.startsWith("text-")
      ? "generateText"
      : "generateContent"
  : "complete";

// MySQL Database Configuration
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "voice_health_db";
const DB_PORT = Number(process.env.DB_PORT || 3306);

let db;

async function initializeDatabase() {
  try {
    db = await mysql.createConnection({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      port: DB_PORT,
    });
    console.log("Connected to MySQL database.");

    // Create patients table to store patient info
    await db.execute(`
      CREATE TABLE IF NOT EXISTS patients (
        id INT AUTO_INCREMENT PRIMARY KEY,
        patient_id VARCHAR(255) UNIQUE NOT NULL,
        patient_name VARCHAR(255),
        phone VARCHAR(20),
        created_at BIGINT,
        INDEX (patient_name),
        INDEX (patient_id)
      )
    `);

    // Create table if it doesn't exist
    await db.execute(`
      CREATE TABLE IF NOT EXISTS records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        patient_id VARCHAR(255) NOT NULL,
        patient_name VARCHAR(255),
        phone VARCHAR(20),
        timestamp BIGINT NOT NULL,
        source VARCHAR(255),
        transcript TEXT,
        language VARCHAR(10),
        text TEXT,
        symptoms JSON,
        duration VARCHAR(255),
        bp VARCHAR(255),
        temperature VARCHAR(255),
        medicines JSON,
        severity VARCHAR(255),
        diagnosis TEXT,
        prescription TEXT,
        missingFields JSON,
        notes TEXT,
        apiProvider VARCHAR(255),
        model VARCHAR(255),
        apiBaseUrl VARCHAR(255),
        apiError TEXT,
        fallback TINYINT(1),
        INDEX (patient_id),
        INDEX (patient_name)
      )
    `);

    // Check if prescription and missingFields columns exist, add if not
    const [columns] = await db.execute("SHOW COLUMNS FROM records");
    const columnNames = columns.map(col => col.Field);
    if (!columnNames.includes("prescription")) {
      await db.execute("ALTER TABLE records ADD COLUMN prescription TEXT");
    }
    if (!columnNames.includes("missingFields")) {
      await db.execute("ALTER TABLE records ADD COLUMN missingFields JSON");
    }
    if (!columnNames.includes("patient_name")) {
      await db.execute("ALTER TABLE records ADD COLUMN patient_name VARCHAR(255)");
    }
    if (!columnNames.includes("phone")) {
      await db.execute("ALTER TABLE records ADD COLUMN phone VARCHAR(20)");
    }

    console.log("Database initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  }
}

function generatePatientId() {
  return `patient-${crypto.randomUUID()}`;
}

async function getNextPatientId() {
  try {
    // Get the highest numeric ID from both patients and records tables to ensure continuity
    const [resultPatients] = await db.execute(
      `SELECT MAX(CAST(SUBSTR(patient_id, 3) AS UNSIGNED)) as maxId FROM patients WHERE patient_id LIKE 'P-%'`
    );
    const [resultRecords] = await db.execute(
      `SELECT MAX(CAST(SUBSTR(patient_id, 3) AS UNSIGNED)) as maxId FROM records WHERE patient_id LIKE 'P-%'`
    );

    const maxPatientId = resultPatients[0]?.maxId || 0;
    const maxRecordId = resultRecords[0]?.maxId || 0;
    const maxId = Math.max(maxPatientId, maxRecordId, 0);

    const nextNumber = maxId + 1;
    const paddedId = String(nextNumber).padStart(4, '0');
    return `P-${paddedId}`;
  } catch (error) {
    console.error("Error generating patient ID:", error);
    return `P-${String(Math.floor(Math.random() * 9999)).padStart(4, '0')}`;
  }
}

async function savePatient(patientId, patientName, phone) {
  try {
    await db.execute(
      `INSERT IGNORE INTO patients (patient_id, patient_name, phone, created_at) VALUES (?, ?, ?, ?)`,
      [patientId, patientName || "", phone || "", Date.now()]
    );
  } catch (error) {
    console.error("Error saving patient info:", error);
  }
}

function detectLanguage(text) {
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  if (hasDevanagari) {
    const marathiMarkers = /\b(काय|हो|आम्ही|तू|रात्र|बघा|म्हणजे|माझं|आहेत)\b/i;
    return marathiMarkers.test(text) ? "mr" : "hi";
  }
  return "en";
}

function normalizeLanguage(code) {
  if (!code) return "auto";
  if (code.startsWith("hi")) return "hi";
  if (code.startsWith("mr")) return "mr";
  if (code.startsWith("en")) return "en";
  return "auto";
}

function mapLanguageForPrompt(code) {
  const normalized = normalizeLanguage(code);
  if (normalized === "hi") return "Hindi";
  if (normalized === "mr") return "Marathi";
  return "English";
}

app.use(cors());
app.use(
  express.json({
    strict: false,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(express.static(FRONTEND_DIR));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    console.error("Invalid JSON body:", err.message);
    console.error("Request headers:", req.headers);
    console.error("Raw body:", req.rawBody);
    return res.status(400).json({
      error: "Invalid JSON body. Please send valid JSON.",
      details: err.message,
    });
  }
  next(err);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0", uptime: process.uptime() });
});

app.get("/debug/records-count", async (req, res) => {
  try {
    const [result] = await db.execute("SELECT COUNT(*) as count FROM records");
    const [patientIds] = await db.execute("SELECT DISTINCT patient_id FROM records LIMIT 10");
    res.json({
      totalRecords: result[0]?.count || 0,
      samplePatientIds: patientIds.map(p => p.patient_id),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/records", async (req, res) => {
  try {
    console.log("Fetching all records (last 50)");
    const [rows] = await db.execute(`SELECT * FROM records ORDER BY timestamp DESC LIMIT 50`);
    console.log(`Found ${rows.length} total records`);
    res.json(rows.map(mapDbRecord));
  } catch (error) {
    console.error("Failed to read records:", error.message, error.stack);
    res.status(500).json({ error: "Unable to fetch records.", details: error.message });
  }
});

app.get("/records/:patientId", async (req, res) => {
  try {
    const patientId = req.params.patientId;
    console.log("Fetching records for patientId:", patientId);
    const [rows] = await db.execute(
      `SELECT * FROM records WHERE patient_id = ? ORDER BY timestamp DESC`,
      [patientId]
    );
    console.log(`Found ${rows.length} records for patient ${patientId}`);
    res.json(rows.map(mapDbRecord));
  } catch (error) {
    console.error("Failed to read patient records:", error.message, error.stack);
    res.status(500).json({ error: "Unable to fetch patient records.", details: error.message });
  }
});

// Get next patient ID
app.get("/next-patient-id", async (req, res) => {
  try {
    const nextId = await getNextPatientId();
    res.json({ patientId: nextId });
  } catch (error) {
    res.status(500).json({ error: "Failed to generate patient ID" });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const todayTimestamp = todayMidnight.getTime();

    // 1. Visits Today
    const [todayRecords] = await db.execute(
      "SELECT COUNT(*) as count FROM records WHERE timestamp >= ?",
      [todayTimestamp]
    );

    // 2. Total Registered Patients (All-time)
    const [totalPatients] = await db.execute("SELECT COUNT(*) as count FROM patients");

    // 3. Aggregate top symptoms from latest records for trend analysis
    const [rows] = await db.execute("SELECT symptoms FROM records ORDER BY timestamp DESC LIMIT 100");
    const symptomMap = {};
    rows.forEach(row => {
      try {
        const symptoms = typeof row.symptoms === 'string' ? JSON.parse(row.symptoms) : (row.symptoms || []);
        symptoms.forEach(s => {
          const normalized = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
          symptomMap[normalized] = (symptomMap[normalized] || 0) + 1;
        });
      } catch (e) { }
    });

    const topSymptoms = Object.entries(symptomMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(entry => entry[0]);

    res.json({
      todayVisits: todayRecords[0]?.count || 0,
      totalPatients: totalPatients[0]?.count || 0,
      topSymptoms: topSymptoms.length > 0 ? topSymptoms : ["None yet"]
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Search patients by name or ID (Case-Insensitive)
app.get("/search-patients", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().toLowerCase();
    if (!query) {
      return res.json([]);
    }

    // Search by name OR ID with case-insensitivity
    const [patients] = await db.execute(
      `SELECT DISTINCT patient_id, patient_name 
       FROM patients 
       WHERE LOWER(patient_name) LIKE ? OR LOWER(patient_id) LIKE ? 
       ORDER BY (LOWER(patient_id) = ?) DESC, patient_name ASC
       LIMIT 10`,
      [`%${query}%`, `%${query}%`, query]
    );
    res.json(patients);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
});

// Get recent patients
app.get("/recent-patients", async (req, res) => {
  try {
    const [patients] = await db.execute(
      `SELECT patient_id, patient_name, MAX(timestamp) as last_visit
       FROM records
       WHERE patient_name IS NOT NULL AND patient_name != ''
       GROUP BY patient_id, patient_name
       ORDER BY last_visit DESC LIMIT 3`
    );
    res.json(patients);
  } catch (error) {
    console.error("Error fetching recent patients:", error);
    res.status(500).json({ error: "Failed to fetch recent patients" });
  }
});

// Create or update patient
app.post("/patients", async (req, res) => {
  try {
    const patientId = req.body?.patientId?.trim();
    const patientName = req.body?.patientName?.trim();
    const phone = req.body?.phone?.trim();

    if (!patientId) {
      return res.status(400).json({ error: "Patient ID is required" });
    }

    await savePatient(patientId, patientName, phone);
    res.json({ success: true, patientId });
  } catch (error) {
    console.error("Error saving patient:", error);
    res.status(500).json({ error: "Failed to save patient" });
  }
});

// Transcribe audio using Groq Whisper API
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file provided." });
  if (!API_KEY) return res.status(400).json({ error: "API Key is missing." });

  try {
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" });
    formData.append("file", blob, "audio.webm");
    formData.append("model", "whisper-large-v3");

    // Explicitly use the translations endpoint for audio -> English
    const endpoint = AI_PROVIDER === "groq"
      ? "https://api.groq.com/openai/v1/audio/translations"
      : "https://api.openai.com/v1/audio/translations";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "Failed to transcribe audio.");
    }

    res.json({ text: data.text });
  } catch (error) {
    console.error("Transcription error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/process", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "Please provide text to analyze." });
  }

  const patientId = String(req.body?.patientId || generatePatientId()).trim();
  const patientName = String(req.body?.patientName || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const source = String(req.body?.source || "manual");
  const languageHint = normalizeLanguage(String(req.body?.languageHint || "auto"));
  const detectedLanguage = detectLanguage(text);
  const language = languageHint === "auto" ? detectedLanguage : languageHint;

  // Save patient info
  if (patientName || phone) {
    await savePatient(patientId, patientName, phone);
  }

  const prompt = `You are a medical information extraction system.
Text may be English, Hindi, or Marathi.
Extract the patient details from the text and return only valid JSON with these keys:
- patientId
- language
- symptoms
- duration
- diagnosis
- medicines
- prescription
- bp
- temperature
- severity
- missingFields
- translatedTranscript
- notes

Rules:
- ALWAYS respond in English language only.
- 'translatedTranscript' should be a full, coherent English translation of the input text.
- MEDICAL RESILIENCE: If a drug name is phonetically similar to a known medicine but misspelled (e.g., 'Parasin' for 'Paracetamol', 'Amlopid' for 'Amlodipine'), use clinical context to resolve and provide the canonical medical name.
- PHARMACIST ACCURACY: Map medication names to standard generic pharmacological names. If a drug name is ambiguous or sounds like multiple drugs, map it to the most likely one but also add 'requires_clarification' to the missingFields array.
- CATEGORIZATION: Only include actual pharmaceutical medications in the 'medicines' array. Lifestyle substances, habits, or social history items (e.g., alcohol, smoking, tobacco) must be placed in 'notes' and never in 'medicines'.
- Convert all extracted values to English (e.g., symptoms, diagnosis, medicines).
- Do not include markdown, explanations, or extra text.
- Return a single JSON object only.
- If any key cannot be determined, return it as an empty string or empty array.
- Always include missingFields as an array of any empty or missing keys.

Patient ID: ${patientId}
Language hint: ${mapLanguageForPrompt(languageHint)}
Text: "${text.replace(/"/g, '\\"')}"`;

  let modelResult = null;
  let modelError = null;
  if (API_KEY) {
    try {
      const endpoint =
        AI_PROVIDER === "groq"
          ? `${API_BASE_URL}/chat/completions`
          : `${API_BASE_URL}/models/${MODEL_NAME}:${MODEL_METHOD}?key=${API_KEY}`;
      const bodyPayload =
        AI_PROVIDER === "groq"
          ? {
            model: MODEL_NAME,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 512,
            temperature: 0.1,
          }
          : MODEL_METHOD === "generateText"
            ? { prompt: { text: prompt } }
            : MODEL_METHOD === "generateMessage"
              ? { messages: [{ author: "user", content: [{ type: "text", text: prompt }] }] }
              : { contents: [{ parts: [{ text: prompt }] }] };

      const headers =
        AI_PROVIDER === "groq"
          ? {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          }
          : { "Content-Type": "application/json" };

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
      });

      const responseText = await response.text();
      const providerLabel = AI_PROVIDER.toUpperCase();
      if (!responseText) {
        modelError = `${providerLabel} API returned empty body (${response.status} ${response.statusText}).`;
        console.warn(modelError, endpoint);
      } else {
        if (response.status !== 200) {
          modelError = `${providerLabel} API request failed with status ${response.status} ${response.statusText}.`;
          console.warn(modelError, endpoint, responseText);
        }

        try {
          const data = JSON.parse(responseText);
          modelResult = extractTextFromModelResponse(data);
          if (!modelResult) {
            modelError = modelError || "Model returned no text payload.";
            console.warn(modelError, response.status, responseText);
          }
        } catch (parseError) {
          modelError = `Failed to parse ${providerLabel} API JSON: ${parseError.message}`;
          console.error(modelError, responseText);
        }
      }
    } catch (error) {
      modelError = `Model API error: ${error.message}`;
      console.error(modelError, error);
    }
  } else {
    modelError = "No API key available; using local fallback parser.";
    console.warn(modelError);
  }

  let finalResult = null;
  if (modelResult?.trim()) {
    try {
      finalResult = parseModelJson(modelResult);
    } catch (error) {
      console.error("Failed to parse model JSON output:", error);
    }
  }

  if (!finalResult) {
    finalResult = {
      ...extractMedicalData(text),
      fallback: true,
      apiError: modelError,
      note: modelError
        ? `Model ${MODEL_NAME} output was invalid or missing; using local fallback extraction.`
        : `Model ${MODEL_NAME} output was invalid or missing; using local fallback extraction.`,
    };
  }

  finalResult = {
    patientId,
    source,
    language,
    ...finalResult,
  };

  res.json(finalResult);
});

// Save approved prescription
app.post("/records", async (req, res) => {
  try {
    const data = req.body;
    const patientId = data.patientId || generatePatientId();
    const timestamp = Date.now();

    // Register patient in the directory (savePatient handles INSERT IGNORE)
    await savePatient(patientId, data.patientName || "", data.phone || "");

    await db.execute(
      `INSERT INTO records (
        patient_id,
        patient_name,
        phone,
        timestamp,
        source,
        transcript,
        language,
        text,
        symptoms,
        duration,
        bp,
        temperature,
        medicines,
        severity,
        diagnosis,
        notes,
        prescription,
        missingFields,
        apiProvider,
        model,
        apiBaseUrl,
        apiError,
        fallback
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patientId,
        data.patientName || "",
        data.phone || "",
        timestamp,
        data.source || "manual",
        data.text || "",
        data.language || "auto",
        data.text || "",
        JSON.stringify(data.symptoms || []),
        data.duration || "",
        data.bp || "",
        data.temperature || "",
        JSON.stringify(data.medicines || []),
        data.severity || "",
        data.diagnosis || "",
        data.notes || "",
        data.prescription || "",
        JSON.stringify(data.missingFields || []),
        data.apiProvider || "",
        data.model || "",
        data.apiBaseUrl || "",
        data.apiError || "",
        data.fallback ? 1 : 0
      ]
    );
    res.json({ success: true, patientId, timestamp });
  } catch (error) {
    console.error("Failed to save approved record:", error);
    res.status(500).json({ error: "Failed to save record." });
  }
});

// Chatbot RAG endpoint: Ask questions about patient history
app.post("/ask", async (req, res) => {
  try {
    const { patientId, question } = req.body;
    if (!patientId || !question) {
      return res.status(400).json({ error: "Patient ID and question are required." });
    }

    // 1. Fetch patient records in chronological order (Oldest to Newest)
    const [records] = await db.execute(
      `SELECT timestamp, symptoms, diagnosis, medicines, prescription, bp, temperature, notes 
       FROM records WHERE patient_id = ? ORDER BY timestamp ASC`,
      [patientId]
    );

    if (records.length === 0) {
      return res.json({ answer: "No history found for this patient." });
    }

    // 2. Construct context
    let historyContext = "";
    const totalRecords = records.length;
    records.forEach((rec, index) => {
      const date = new Date(Number(rec.timestamp)).toLocaleDateString();
      const isLatest = index === totalRecords - 1;

      const parseField = (f) => {
        if (Array.isArray(f)) return f.join(", ");
        if (typeof f === 'string') {
          try {
            const parsed = JSON.parse(f);
            return Array.isArray(parsed) ? parsed.join(", ") : String(parsed);
          } catch (e) { return f; }
        }
        return String(f || "N/A");
      };

      const symptoms = parseField(rec.symptoms);
      const medicines = parseField(rec.medicines);

      historyContext += `Visit ${index + 1}${isLatest ? " (LATEST)" : ""} (${date}):
- Symptoms: ${symptoms}
- Diagnosis: ${rec.diagnosis || "N/A"}
- Medications: ${medicines}
- BP: ${rec.bp || "N/A"}
- Temperature: ${rec.temperature || "N/A"}
- Notes: ${rec.notes || "N/A"}
\n`;
    });

    const ragPrompt = `You are a medical assistant reviewing a patient's history.
Today's Date: ${new Date().toLocaleDateString()}

Based on the chronological visit history below (oldest to latest), answer the doctor's question. 
The very last visit in the list is the most recent (LATEST).

PATIENT HISTORY:
${historyContext}

DOCTOR'S QUESTION:
${question}

ANSWER:`;

    // 3. Call LLM
    let answer = "I'm sorry, I couldn't process that question right now.";

    if (API_KEY) {
      const endpoint = AI_PROVIDER === "groq"
        ? `${API_BASE_URL}/chat/completions`
        : `${API_BASE_URL}/models/${MODEL_NAME}:${MODEL_METHOD}?key=${API_KEY}`;

      const bodyPayload = AI_PROVIDER === "groq"
        ? {
          model: MODEL_NAME,
          messages: [{ role: "user", content: ragPrompt }],
          max_tokens: 300,
          temperature: 0.1,
        }
        : MODEL_METHOD === "generateText"
          ? { prompt: { text: ragPrompt } }
          : { contents: [{ parts: [{ text: ragPrompt }] }] };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(AI_PROVIDER === "groq" ? { "Authorization": `Bearer ${API_KEY}` } : {}) },
        body: JSON.stringify(bodyPayload),
      });

      const responseText = await response.text();
      if (response.ok && responseText) {
        const data = JSON.parse(responseText);
        answer = extractTextFromModelResponse(data) || answer;
      }
    }

    res.json({ answer });
  } catch (error) {
    console.error("Chatbot Error:", error);
    res.status(500).json({ error: "Failed to answer question." });
  }
});

function mapDbRecord(record) {
  const safeJsonParse = (value, defaultValue = []) => {
    if (!value) return defaultValue;
    if (typeof value !== 'string') return value; // Already parsed
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error("Failed to parse JSON string:", value, e);
      return defaultValue;
    }
  };

  return {
    ...record,
    symptoms: safeJsonParse(record.symptoms, []),
    medicines: safeJsonParse(record.medicines, []),
    missingFields: safeJsonParse(record.missingFields, []),
    fallback: Boolean(record.fallback),
  };
}

app.get("*", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Using model: ${MODEL_NAME} (${MODEL_METHOD})`);
      if (!API_KEY) {
        console.warn(
          `Warning: ${AI_PROVIDER.toUpperCase()}_API_KEY is not set. Add it to .env or environment variables, or set AI_PROVIDER to google/groq.`
        );
      }
    });
  } catch (error) {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  }
}

startServer();

function extractTextFromModelResponse(data) {
  if (!data) return "";
  return (
    data?.text ||
    data?.choices?.[0]?.text ||
    data?.choices?.[0]?.message?.content?.[0]?.text ||
    data?.choices?.[0]?.message?.content ||
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.[0]?.text ||
    data?.candidates?.[0]?.output ||
    data?.output?.[0]?.content?.text ||
    data?.output?.[0]?.content?.[0]?.text ||
    data?.output?.[0]?.message?.content?.[0]?.text ||
    ""
  );
}

function extractMedicalData(text) {
  const lower = text.toLowerCase();
  const symptoms = [];
  const symptomKeywords = [
    { keyword: "बुखार", label: "fever" },
    { keyword: "खांसी", label: "cough" },
    { keyword: "सिर दर्द", label: "headache" },
    { keyword: "सिरदर्द", label: "headache" },
    { keyword: "मतली", label: "nausea" },
    { keyword: "चक्कर", label: "dizziness" },
    { keyword: "दर्द", label: "pain" },
    { keyword: "गला खराब", label: "sore throat" },
    { keyword: "सांस लेने में तकलीफ", label: "shortness of breath" },
    { keyword: "थकान", label: "fatigue" },
    { keyword: "कंपकपी", label: "chills" },
    { keyword: "उल्टी", label: "vomiting" },
    { keyword: "दस्त", label: "diarrhea" },
    { keyword: "fever", label: "fever" },
    { keyword: "cough", label: "cough" },
    { keyword: "headache", label: "headache" },
    { keyword: "nausea", label: "nausea" },
    { keyword: "dizziness", label: "dizziness" },
    { keyword: "pain", label: "pain" },
    { keyword: "sore throat", label: "sore throat" },
    { keyword: "shortness of breath", label: "shortness of breath" },
    { keyword: "fatigue", label: "fatigue" },
    { keyword: "chills", label: "chills" },
    { keyword: "vomiting", label: "vomiting" },
    { keyword: "diarrhea", label: "diarrhea" },
  ];

  symptomKeywords.forEach(({ keyword, label }) => {
    if (lower.includes(keyword) && !symptoms.includes(label)) {
      symptoms.push(label);
    }
  });

  const durationMatch = text.match(/\d+\s?(?:days?|weeks?|months?|hours?|दिन|हफ्ते|महीने|घंटे|मिनट)(?:\s*से)?/i);
  const bpMatch = text.match(/\b(?:bp|blood pressure|ब्लड प्रेशर)[:\s]*([0-9]{2,3}\/\d{2,3})\b/i);
  const tempMatch = text.match(/\b(\d{2}(?:\.\d+)?\s?(?:°\s?[CF]|डिग्री\s?[CF]|℃|℉)?)\b/i);
  const severityMatch = text.match(/\b(mild|moderate|severe|critical|urgent|हल्का|मध्यम|तीव्र|गंभीर)\b/i);

  const medsMatch = text.match(/(?:took|taking|on|medicine|medications|tablet|pills?|दवा|गोलियां|शराबी|इंजेक्शन)[:\s]*([A-Za-z0-9\u0900-\u097F ,\-]+)/i);
  const medicines = medsMatch
    ? medsMatch[1]
      .split(/,| and |;|\band\b|और|,|;/gi)
      .map((item) => item.trim())
      .filter(Boolean)
    : [];

  const diagnosisKeywords = [
    { keyword: "dengue", label: "dengue" },
    { keyword: "malaria", label: "malaria" },
    { keyword: "influenza", label: "influenza" },
    { keyword: "covid", label: "covid-19" },
    { keyword: "cold", label: "common cold" },
    { keyword: "flu", label: "influenza" },
    { keyword: "infection", label: "infection" },
    { keyword: "stomach", label: "stomach infection" },
    { keyword: "gastritis", label: "gastritis" },
    { keyword: "viral", label: "viral infection" },
    { keyword: "बुखार", label: "fever" },
    { keyword: "डेंगू", label: "dengue" },
    { keyword: "मलेरिया", label: "malaria" },
    { keyword: "सर्दी", label: "common cold" },
    { keyword: "कफ", label: "respiratory infection" },
  ];
  const diagnosis = diagnosisKeywords.reduce((value, item) => {
    if (!value && lower.includes(item.keyword)) {
      return item.label;
    }
    return value;
  }, "");

  const prescription = medicines.length
    ? `Prescribe ${medicines.join(", ")} as appropriate.`
    : diagnosis
      ? `Review diagnosis: ${diagnosis}, then prescribe medication.`
      : "";

  const missingFields = [];
  if (symptoms.length === 0) missingFields.push("symptoms");
  if (!durationMatch?.[0]) missingFields.push("duration");
  if (!diagnosis) missingFields.push("diagnosis");
  if (medicines.length === 0) missingFields.push("medicines");
  if (!bpMatch?.[1]) missingFields.push("bp");
  if (!tempMatch?.[1]) missingFields.push("temperature");
  if (!severityMatch?.[1]) missingFields.push("severity");

  return {
    symptoms,
    duration: durationMatch?.[0] || "",
    bp: bpMatch?.[1] || "",
    temperature: tempMatch?.[1] || "",
    medicines,
    severity: severityMatch?.[1] || "",
    diagnosis,
    prescription,
    missingFields,
    notes: text,
  };
}

function parseModelJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const match = cleaned.match(/(\{[\s\S]*\})/);
  const candidate = match?.[1] || cleaned;

  try {
    return JSON.parse(candidate);
  } catch (error) {
    console.error("Failed to parse JSON from model output:", candidate);
    throw new Error("Unable to parse model output as JSON.");
  }
}