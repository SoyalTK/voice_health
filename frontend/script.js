const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
const historyKey = "voiceHealthHistory";
const BACKEND_URL =
  window.location.hostname === "localhost" && window.location.port === "3000"
    ? ""
    : "http://localhost:3000";

const statusEl = document.getElementById("status");
const backendUrlEl = document.getElementById("backend-url");
const transcriptEl = document.getElementById("transcript");
const resultEl = document.getElementById("result");
const historyEl = document.getElementById("history");
const visitHistoryEl = document.getElementById("visit-history");
const visitStatusEl = document.getElementById("visit-status");
const manualTextEl = document.getElementById("manual-text");
const patientIdInput = document.getElementById("patient-id");
const languageSelect = document.getElementById("language-select");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");

if (recognition) {
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = handleSpeechResult;
  recognition.onerror = handleSpeechError;
  recognition.onend = () => setStatus("Voice capture stopped.");
} else {
  setStatus("Speech recognition is not supported in this browser. Use manual text input.", true);
  startBtn.disabled = true;
  stopBtn.disabled = true;
}

function getSelectedSpeechLanguage() {
  const selected = languageSelect?.value || "auto";
  if (selected === "hi") return "hi-IN";
  if (selected === "mr") return "mr-IN";
  if (selected === "en") return "en-IN";
  return "en-IN";
}

async function startListening() {
  if (!recognition) return;
  recognition.lang = getSelectedSpeechLanguage();
  setStatus("Listening... please speak clearly.");
  recognition.start();
}

function stopListening() {
  if (!recognition) return;
  recognition.stop();
}

async function handleSpeechResult(event) {
  const transcript = event.results[0][0].transcript;
  transcriptEl.innerText = transcript;
  manualTextEl.value = transcript;
  await sendTextForAnalysis(transcript, "voice");
}

function handleSpeechError(event) {
  setStatus(`Speech recognition error: ${event.error}`, true);
}

function generatePatientId() {
  const newId = window.crypto?.randomUUID
    ? `patient-${window.crypto.randomUUID()}`
    : `patient-${Math.random().toString(36).slice(2, 10)}`;
  if (patientIdInput) {
    patientIdInput.value = newId;
  }
  setStatus(`Generated Patient ID: ${newId}`);
}

async function analyzeManualText() {
  const text = manualTextEl.value.trim();
  if (!text) {
    setStatus("Enter notes or use voice input first.", true);
    return;
  }
  transcriptEl.innerText = text;
  await sendTextForAnalysis(text, "manual");
}

async function loadPatientHistory() {
  const patientId = patientIdInput?.value?.trim();
  if (!patientId) {
    setStatus("Enter a Patient ID first to recall visits.", true);
    visitStatusEl.textContent = "No Patient ID provided.";
    visitStatusEl.className = "status error";
    return;
  }

  visitHistoryEl.innerHTML = "";
  visitStatusEl.textContent = "Loading patient visit history...";
  visitStatusEl.className = "status";
  console.log("Fetching history for Patient ID:", patientId);

  try {
    const url = `${BACKEND_URL}/records/${encodeURIComponent(patientId)}`;
    console.log("API URL:", url);
    const response = await fetch(url);
    console.log("Response status:", response.status);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to fetch patient history.");
    }

    if (!data.length) {
      visitHistoryEl.innerHTML = "<li class='empty'>No visits found for this patient ID.</li>";
      visitStatusEl.textContent = "No visits found.";
      visitStatusEl.className = "status";
      return;
    }

    renderVisitHistory(data);
    visitStatusEl.textContent = `${data.length} visit(s) found for ${patientId}.`;
    visitStatusEl.className = "status success";
  } catch (error) {
    console.error("Error loading patient history:", error);
    visitStatusEl.textContent = `Failed to load patient history: ${error.message}`;
    visitStatusEl.className = "status error";
    visitHistoryEl.innerHTML = "";
  }
}

function renderVisitHistory(records) {
  visitHistoryEl.innerHTML = "";
  records.forEach((record) => {
    const item = document.createElement("li");
    item.className = "history-item";
    item.innerHTML = `
      <div class="history-header">
        <strong>${new Date(record.timestamp).toLocaleString()}</strong>
      </div>
      <p><em>Source:</em> ${record.source}</p>
      <p><em>Language:</em> ${record.language}</p>
      <p><em>Diagnosis:</em> ${record.diagnosis || "N/A"}</p>
      <p><em>Prescription:</em> ${escapeHtml(record.prescription || "N/A")}</p>
      <p><em>Missing fields:</em> ${(record.missingFields || []).join(", ") || "none"}</p>
      <pre>${JSON.stringify(record, null, 2)}</pre>
    `;
    visitHistoryEl.appendChild(item);
  });
}

async function sendTextForAnalysis(text, source) {
  setStatus("Analyzing... please wait.");
  try {
    const url = `${BACKEND_URL}/process`;
    const body = {
      text,
      source,
      patientId: patientIdInput?.value?.trim() || undefined,
      languageHint: languageSelect?.value || "auto",
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Server returned an error.");
    }

    resultEl.innerText = JSON.stringify(data, null, 2);
    setStatus("Analysis complete.");
    saveHistory({
      timestamp: Date.now(),
      source,
      patientId: data.patientId || body.patientId || "unknown",
      language: data.language || body.languageHint || "auto",
      text,
      result: data,
    });
  } catch (error) {
    setStatus(`Failed to analyze text: ${error.message}`, true);
    resultEl.innerText = "{}";
  }
}

function saveHistory(record) {
  const existing = JSON.parse(localStorage.getItem(historyKey) || "[]");
  existing.unshift(record);
  localStorage.setItem(historyKey, JSON.stringify(existing.slice(0, 10)));
  renderHistory();
}

function renderHistory() {
  const items = JSON.parse(localStorage.getItem(historyKey) || "[]");
  historyEl.innerHTML = "";
  if (items.length === 0) {
    historyEl.innerHTML = "<li class='empty'>No history yet.</li>";
    return;
  }

  items.forEach((record, index) => {
    const item = document.createElement("li");
    item.className = "history-item";
    item.innerHTML = `
      <div class="history-header">
        <strong>${new Date(record.timestamp).toLocaleString()}</strong>
        <button class="delete-btn" onclick="deleteHistoryItem(${index})" title="Delete this record">×</button>
      </div>
      <p><em>Patient ID:</em> ${record.patientId || "unknown"}</p>
      <p><em>Language:</em> ${record.language || "auto"}</p>
      <p><em>Source:</em> ${record.source}</p>
      <p>${escapeHtml(record.text)}</p>
      <pre>${JSON.stringify(record.result, null, 2)}</pre>
    `;
    historyEl.appendChild(item);
  });
}

function deleteHistoryItem(index) {
  const items = JSON.parse(localStorage.getItem(historyKey) || "[]");
  items.splice(index, 1);
  localStorage.setItem(historyKey, JSON.stringify(items));
  renderHistory();
}

function clearAllHistory() {
  if (confirm("Are you sure you want to delete all history records?")) {
    localStorage.removeItem(historyKey);
    renderHistory();
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "status error" : "status";
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

window.addEventListener("DOMContentLoaded", () => {
  renderHistory();
  backendUrlEl.innerText = `Backend: ${BACKEND_URL || "same origin"}`;

  if (window.location.hostname === "localhost" && window.location.port && window.location.port !== "3000") {
    setStatus(
      `Warning: page loaded from localhost:${window.location.port}. Open the app from http://localhost:3000 instead of Live Server to avoid extension messaging errors.`,
      true
    );
  }
});
