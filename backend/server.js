import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const DB_DIR = path.resolve(__dirname, "data");
const DB_PATH = path.join(DB_DIR, "patient_records.db");
const app = express();
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

let db;

async function initializeDatabase() {
  await fs.mkdir(DB_DIR, { recursive: true });
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT,
      transcript TEXT,
      language TEXT,
      text TEXT,
      symptoms TEXT,
      duration TEXT,
      bp TEXT,
      temperature TEXT,
      medicines TEXT,
      severity TEXT,
      diagnosis TEXT,
      prescription TEXT,
      missingFields TEXT,
      notes TEXT,
      apiProvider TEXT,
      model TEXT,
      apiBaseUrl TEXT,
      apiError TEXT,
      fallback INTEGER
    );
  `);

  const tableInfo = await db.all("PRAGMA table_info(records)");
  const columns = tableInfo.map((column) => column.name);
  if (!columns.includes("prescription")) {
    await db.exec("ALTER TABLE records ADD COLUMN prescription TEXT;");
  }
  if (!columns.includes("missingFields")) {
    await db.exec("ALTER TABLE records ADD COLUMN missingFields TEXT;");
  }
}

function generatePatientId() {
  return `patient-${crypto.randomUUID()}`;
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

app.get("/records", async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM records ORDER BY timestamp DESC LIMIT 50`);
    res.json(rows.map(mapDbRecord));
  } catch (error) {
    console.error("Failed to read records:", error);
    res.status(500).json({ error: "Unable to fetch records." });
  }
});

app.get("/records/:patientId", async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM records WHERE patient_id = ? ORDER BY timestamp DESC`, req.params.patientId);
    res.json(rows.map(mapDbRecord));
  } catch (error) {
    console.error("Failed to read patient records:", error);
    res.status(500).json({ error: "Unable to fetch patient records." });
  }
});

app.post("/process", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "Please provide text to analyze." });
  }

  const patientId = String(req.body?.patientId || generatePatientId()).trim();
  const source = String(req.body?.source || "manual");
  const languageHint = normalizeLanguage(String(req.body?.languageHint || "auto"));
  const detectedLanguage = detectLanguage(text);
  const language = languageHint === "auto" ? detectedLanguage : languageHint;

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
- notes

Rules:
- Use English values.
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
    apiProvider: AI_PROVIDER,
    model: MODEL_NAME,
    apiBaseUrl: API_BASE_URL,
    ...finalResult,
  };

  try {
    await db.run(
      `INSERT INTO records (
        patient_id,
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
        apiProvider,
        model,
        apiBaseUrl,
        apiError,
        fallback
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      patientId,
      Date.now(),
      source,
      text,
      language,
      text,
      JSON.stringify(finalResult.symptoms || []),
      finalResult.duration || "",
      finalResult.bp || "",
      finalResult.temperature || "",
      JSON.stringify(finalResult.medicines || []),
      finalResult.severity || "",
      finalResult.diagnosis || "",
      finalResult.notes || "",
      finalResult.prescription || "",
      JSON.stringify(finalResult.missingFields || []),
      AI_PROVIDER,
      MODEL_NAME,
      API_BASE_URL,
      finalResult.apiError || "",
      finalResult.fallback ? 1 : 0
    );
  } catch (error) {
    console.error("Failed to save record:", error);
  }

  res.json(finalResult);
});

function mapDbRecord(record) {
  return {
    ...record,
    symptoms: record.symptoms ? JSON.parse(record.symptoms) : [],
    medicines: record.medicines ? JSON.parse(record.medicines) : [],
    missingFields: record.missingFields ? JSON.parse(record.missingFields) : [],
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