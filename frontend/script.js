const historyKey = "voiceHealthHistory";
let mediaRecorder;
let audioChunks = [];
const BACKEND_URL =
  window.location.hostname === "localhost" && window.location.port === "3000"
    ? ""
    : "http://localhost:3000";

let isProcessing = false; // Prevent multiple simultaneous analyses
let isListening = false; // Track if we're actively listening
let chatIsRecording = false; // Track if we're recording for the chatbot
let accumulatedTranscript = ""; // Accumulate all speech until manual stop

// Check server connectivity on page load
async function checkServerConnection() {
  try {
    const response = await fetch(`${BACKEND_URL}/health`);
    if (!response.ok) {
      console.warn("Server health check failed:", response.status);
      setStatus("Warning: Backend server may not be responding properly.", true);
    }
  } catch (error) {
    console.error("Server connection check failed:", error);
    setStatus("Error: Cannot connect to backend server. Please check if the server is running.", true);
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  checkServerConnection();
  loadStats(); // Load initial hospital analytics
  initTheme(); // Initialize theme preference
});

function initTheme() {
  const savedTheme = localStorage.getItem("theme");
  if (savedTheme === "dark") {
    document.body.classList.add("dark-mode");
    updateThemeUI(true);
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle("dark-mode");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateThemeUI(isDark);
}

function updateThemeUI(isDark) {
  const themeIcon = document.getElementById("theme-icon");
  const themeText = document.getElementById("theme-text");
  if (themeIcon) themeIcon.innerText = isDark ? "☀️" : "🌙";
  if (themeText) themeText.innerText = isDark ? "Day Mode" : "Night Mode";
}

const statusEl = document.getElementById("status");
const backendUrlEl = document.getElementById("backend-url");
const transcriptEl = document.getElementById("transcript");
const prescriptionContainer = document.getElementById("prescription-container");
const prescSymptoms = document.getElementById("presc-symptoms");
const prescDuration = document.getElementById("presc-duration");
const prescBp = document.getElementById("presc-bp");
const prescTemperature = document.getElementById("presc-temperature");
const prescDiagnosis = document.getElementById("presc-diagnosis");
const prescSeverity = document.getElementById("presc-severity");
const prescMedicines = document.getElementById("presc-medicines");
const prescNotes = document.getElementById("presc-notes");
const prescWarning = document.getElementById("presc-warning");
const missingFieldsAlert = document.getElementById("missing-fields-alert");
const missingFieldsList = document.getElementById("missing-fields-list");

let currentDraftData = null;
const historyEl = document.getElementById("history");
const visitHistoryEl = document.getElementById("visit-history");
const visitStatusEl = document.getElementById("visit-status");
const manualTextEl = document.getElementById("manual-text");
const patientIdInput = document.getElementById("patient-id");
const patientNameInput = document.getElementById("patient-name");
const patientPhoneInput = document.getElementById("patient-phone");
const patientSearchInput = document.getElementById("patient-search");
const languageSelect = document.getElementById("language-select");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");

// Stats Elements
const statsRibbon = document.getElementById("stats-ribbon");
const statTotal = document.getElementById("stat-total");
const statPatients = document.getElementById("stat-patients");
const statSymptoms = document.getElementById("stat-symptoms");

// MediaRecorder check
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus("Audio recording is not supported in this browser. Use manual text input.", true);
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
  if (isProcessing) {
    setStatus("Still processing previous speech. Please wait.", true);
    return;
  }
  if (isListening) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        noiseSuppression: true, 
        echoCancellation: true 
      } 
    });
    
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      if (chatIsRecording) {
        await handleChatVoiceInput(audioBlob);
      } else {
        await sendAudioForTranscription(audioBlob);
      }
    };

    mediaRecorder.start();
    isListening = true;
    
    // Only clear main UI if NOT recording for the chatbot
    if (!chatIsRecording) {
      transcriptEl.innerText = "";
      manualTextEl.value = "";
    }
    
    setStatus("Listening... Speak clearly. Click 'Stop Recording' when done.");
    
    // UI update for visual feedback
    startBtn.style.background = "#ef4444";
    startBtn.innerText = "🔴 Recording...";
  } catch (error) {
    console.error("Microphone access error:", error);
    setStatus("Failed to access microphone. Check permissions.", true);
  }
}

function stopListening() {
  if (!mediaRecorder || !isListening) return;

  isListening = false;
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach(track => track.stop());
  
  setStatus("Transcribing audio... please wait.");
  isProcessing = true;
  
  startBtn.style.background = "#0f172a";
  startBtn.innerText = "Start Speaking";
}

async function sendAudioForTranscription(audioBlob) {
  try {
    const formData = new FormData();
    formData.append("audio", audioBlob);
    formData.append("language", languageSelect?.value || "auto");

    const response = await fetch(`${BACKEND_URL}/transcribe`, {
      method: "POST",
      body: formData
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Transcription failed");

    transcriptEl.innerText = data.text;
    manualTextEl.value = data.text;
    await sendTextForAnalysis(data.text, "voice");
  } catch (error) {
    setStatus(`Transcription error: ${error.message}`, true);
    isProcessing = false;
  }
}

// Function removed - using MediaRecorder now
function handleSpeechResult(event) {}

// Function removed - using MediaRecorder now
function handleSpeechError(event) {
  console.error("Speech recognition error:", event.error, event);

  // Reset listening state on error
  isListening = false;

  // Handle specific error types with clear user guidance
  if (event.error === 'network' || event.error === 'service-not-allowed') {
    setStatus("❌ Speech recognition blocked. Please:\n1. Allow microphone access in browser\n2. Disable browser extensions\n3. Try Chrome/Firefox", true);
  } else if (event.error === 'no-speech') {
    setStatus("🎤 No speech detected. Please speak clearly into the microphone and try again.", true);
  } else if (event.error === 'aborted') {
    // This is normal when manually stopped, don't show error
    return;
  } else if (event.error === 'not-allowed') {
    setStatus("❌ Microphone access denied. Click the camera/microphone icon in the address bar to allow access.", true);
  } else if (event.error === 'audio-capture') {
    setStatus("❌ Audio capture failed. Check your microphone connection and try again.", true);
  } else {
    // Handle the "message channel closed" error specifically
    if (event.error === 'unknown' || event.message?.includes('message channel') || event.message?.includes('asynchronous response')) {
      setStatus("⚠️ Browser extension interference detected. Try:\n1. Disabling extensions temporarily\n2. Using incognito/private mode\n3. Refreshing the page", true);
    } else {
      setStatus(`❌ Speech recognition error: ${event.error}. Try refreshing the page or using a different browser.`, true);
    }
  }
}

async function generateNewPatientId() {
  try {
    visitStatusEl.textContent = "Generating new patient ID...";
    const response = await fetch(`${BACKEND_URL}/next-patient-id`);
    const data = await response.json();
    if (patientIdInput) {
      patientIdInput.value = data.patientId;
    }
    patientNameInput.value = "";
    patientPhoneInput.value = "";
    visitStatusEl.textContent = `Generated Patient ID: ${data.patientId}`;
    visitStatusEl.className = "status success";
  } catch (error) {
    setStatus(`Failed to generate patient ID: ${error.message}`, true);
  }
}

function clearCurrentConsultation() {
  // Clears the clinical data but KEEPS the Patient Identity (ID, Name, Phone)
  if (transcriptEl) transcriptEl.innerText = "No transcript yet...";
  if (manualTextEl) manualTextEl.value = "";
  if (prescriptionContainer) prescriptionContainer.style.display = "none";
  if (missingFieldsAlert) missingFieldsAlert.style.display = "none";
  
  const chatAnswerEl = document.getElementById("chat-answer"); // Locate it if not global
  if (chatAnswerEl) {
    chatAnswerEl.style.display = "none";
    chatAnswerEl.innerText = "";
  }
  
  // Reset clinical draft state
  currentDraftData = null;
  accumulatedTranscript = "";
  
  // Clear clinical form fields
  if (prescSymptoms) prescSymptoms.value = "";
  if (prescDuration) prescDuration.value = "";
  if (prescBp) prescBp.value = "";
  if (prescTemperature) prescTemperature.value = "";
  if (prescDiagnosis) prescDiagnosis.value = "";
  if (prescSeverity) prescSeverity.value = "low";
  if (prescMedicines) prescMedicines.value = "";
  if (prescNotes) prescNotes.value = "";
  
  setStatus("Cleared clinical fields. Identity preserved for new visit.");
}

async function searchPatientsByName() {
  const query = patientSearchInput?.value?.trim();
  if (!query) {
    setStatus("Enter a patient name to search.", true);
    visitHistoryEl.innerHTML = "";
    return;
  }

  visitHistoryEl.innerHTML = "";
  visitStatusEl.textContent = "Searching for patients...";
  visitStatusEl.className = "status";

  try {
    const response = await fetch(`${BACKEND_URL}/search-patients?q=${encodeURIComponent(query)}`);
    const patients = await response.json();

    if (!patients.length) {
      visitHistoryEl.innerHTML = "<li class='empty'>No patients found.</li>";
      visitStatusEl.textContent = "No patients found.";
      return;
    }

    renderPatientList(patients);
    
    // Auto-select if only one patient is found to make chatbot instantly usable
    if (patients.length === 1) {
      selectPatient(patients[0].patient_id, patients[0].patient_name);
    }
    
    visitStatusEl.textContent = `Found ${patients.length} patient(s).`;
    visitStatusEl.className = "status success";
  } catch (error) {
    visitStatusEl.textContent = `Search failed: ${error.message}`;
    visitStatusEl.className = "status error";
  }
}

async function loadRecentPatients() {
  visitHistoryEl.innerHTML = "";
  visitStatusEl.textContent = "Loading recent patients...";
  visitStatusEl.className = "status";

  try {
    const response = await fetch(`${BACKEND_URL}/recent-patients`);
    const patients = await response.json();

    if (!patients.length) {
      visitHistoryEl.innerHTML = "<li class='empty'>No recent patients found.</li>";
      visitStatusEl.textContent = "No recent patients.";
      return;
    }

    renderPatientList(patients);
    visitStatusEl.textContent = `${patients.length} recent patient(s).`;
    visitStatusEl.className = "status success";
  } catch (error) {
    visitStatusEl.textContent = `Failed to load recent patients: ${error.message}`;
    visitStatusEl.className = "status error";
  }
}

function renderPatientList(patients) {
  visitHistoryEl.innerHTML = "";
  patients.forEach((patient) => {
    const item = document.createElement("li");
    item.className = "history-item clickable";
    item.innerHTML = `
      <strong>${patient.patient_name || "Unknown"}</strong> (${patient.patient_id})
    `;
    item.onclick = () => selectPatient(patient.patient_id, patient.patient_name);
    visitHistoryEl.appendChild(item);
  });
}

function selectPatient(patientId, patientName) {
  if (patientIdInput) {
    patientIdInput.value = patientId;
  }
  if (patientNameInput) {
    patientNameInput.value = patientName || "";
  }
  
  // Clear any previous patient's chatbot answer
  if (chatAnswerEl) {
    chatAnswerEl.style.display = "none";
    chatAnswerEl.innerText = "";
  }
  if (chatQueryInput) {
    chatQueryInput.value = "";
  }

  setStatus(`Selected patient: ${patientName} (${patientId})`);
  loadPatientHistory();
}

function generatePatientId() {
  // For backward compatibility
  generateNewPatientId();
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
    
    // Ensure we have a clean array for symptoms
    const symptoms = Array.isArray(record.symptoms) ? record.symptoms : [];
    
    item.innerHTML = `
      <div class="history-header">
        <strong>Visit Date: ${new Date(Number(record.timestamp)).toLocaleString()}</strong>
      </div>
      <p><strong>Symptoms:</strong> ${symptoms.join(", ") || "None recorded"}</p>
      <p><em>Diagnosis:</em> ${record.diagnosis || "N/A"}</p>
      <small>Medicines: ${(record.medicines || []).join(", ")}</small>
      <pre style="margin-top: 10px; font-size: 0.8rem;">${JSON.stringify(getCleanRecord(record), null, 2)}</pre>
    `;
    visitHistoryEl.appendChild(item);
  });
}

function getCleanRecord(obj) {
  if (!obj) return {};
  
  // Internal Metadata that should not be shown in the clinical JSON view
  const omitKeys = [
    "apiProvider", "model", "apiBaseUrl", "apiError", "fallback",
    "id", "patientId", "patient_id", "patientName", "patient_name", 
    "phone", "timestamp", "source", "language", "text", "translatedTranscript", 
    "transcript", "created_at"
  ];
  
  // Create a new object with priority order
  const clean = {};
  
  // 1. Clinical Priority Keys
  if (obj.symptoms) clean.symptoms = obj.symptoms;
  if (obj.diagnosis) clean.diagnosis = obj.diagnosis;
  if (obj.medicines) clean.medicines = obj.medicines;
  if (obj.prescription) clean.prescription = obj.prescription;
  
  // 2. Observations
  if (obj.bp) clean.bp = obj.bp;
  if (obj.temperature) clean.temperature = obj.temperature;
  if (obj.severity) clean.severity = obj.severity;
  if (obj.duration) clean.duration = obj.duration;
  
  // 3. Add all other keys NOT in omitKeys and NOT already added
  Object.keys(obj).forEach(key => {
    if (!omitKeys.includes(key) && !(key in clean)) {
      clean[key] = obj[key];
    }
  });
  
  return clean;
}

async function sendTextForAnalysis(text, source) {
  setStatus("Analyzing... please wait.");
  try {
    const url = `${BACKEND_URL}/process`;
    const body = {
      text,
      source,
      patientId: patientIdInput?.value?.trim() || undefined,
      patientName: patientNameInput?.value?.trim() || undefined,
      phone: patientPhoneInput?.value?.trim() || undefined,
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

    currentDraftData = {
      ...data,
      source,
      patientName: body.patientName || "unknown",
      phone: body.phone || "unknown",
      text: data.translatedTranscript || text 
    };

    // Replace original language with English in the UI
    if (data.translatedTranscript) {
      if (transcriptEl) transcriptEl.innerText = data.translatedTranscript;
      if (manualTextEl) manualTextEl.value = data.translatedTranscript;
    }

    // Populate form
    if (prescriptionContainer) prescriptionContainer.style.display = "block";
    if (prescSymptoms) prescSymptoms.value = (data.symptoms || []).join(", ");
    if (prescDuration) prescDuration.value = data.duration || "";
    if (prescBp) prescBp.value = data.bp || "";
    if (prescTemperature) prescTemperature.value = data.temperature || "";
    if (prescDiagnosis) prescDiagnosis.value = data.diagnosis || "";
    if (prescSeverity) prescSeverity.value = data.severity || "";
    if (prescMedicines) prescMedicines.value = (data.medicines || []).join(", ");
    if (prescNotes) prescNotes.value = data.notes || "";
    
    // Check missing fields for alert
    if (data.missingFields && data.missingFields.length > 0) {
      if(missingFieldsAlert) missingFieldsAlert.style.display = "block";
      const displayFields = data.missingFields.filter(f => f !== 'requires_clarification');
      if(missingFieldsList) missingFieldsList.innerText = displayFields.join(", ");
      
      const requiresClarification = data.missingFields.includes("requires_clarification");
      if (requiresClarification) {
        if(prescWarning) prescWarning.innerText = "Warning: Some medications were spoken ambiguously and a best-guess match was used. Please verify with patient.";
      } else {
        if(prescWarning) prescWarning.innerText = "";
      }
    } else {
      if(missingFieldsAlert) missingFieldsAlert.style.display = "none";
      if(prescWarning) prescWarning.innerText = "";
    }

    setStatus("Draft Prescription generated. Please review and approve.");
  } catch (error) {
    setStatus(`Failed to analyze text: ${error.message}`, true);
    if(prescriptionContainer) prescriptionContainer.style.display = "none";
  } finally {
    isProcessing = false; // Always reset processing flag
  }
}

async function savePrescription() {
  if (!currentDraftData) return;
  
  setStatus("Saving approved prescription...");
  try {
    // Collect updated data from form
    const updatedData = {
      ...currentDraftData,
      symptoms: (prescSymptoms?.value || "").split(",").map(s => s.trim()).filter(Boolean),
      duration: (prescDuration?.value || "").trim(),
      bp: (prescBp?.value || "").trim(),
      temperature: (prescTemperature?.value || "").trim(),
      diagnosis: (prescDiagnosis?.value || "").trim(),
      severity: prescSeverity?.value || "",
      medicines: (prescMedicines?.value || "").split(",").map(m => m.trim()).filter(Boolean),
      notes: (prescNotes?.value || "").trim()
    };
    
    // Ensure prescription text exists, or regenerate based on edits
    if (!updatedData.prescription) {
      if (updatedData.medicines && updatedData.medicines.length > 0) {
        updatedData.prescription = `Prescribe ${updatedData.medicines.join(", ")}`;
      } else if (updatedData.diagnosis) {
        updatedData.prescription = `Reviewed diagnosis: ${updatedData.diagnosis}`;
      }
    }

    const response = await fetch(`${BACKEND_URL}/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedData)
    });
    
    const dbRes = await response.json();
    if (!response.ok) throw new Error(dbRes.error || "Failed to save to database");

    // Clear form UI
    if (prescriptionContainer) prescriptionContainer.style.display = "none";
    if (missingFieldsAlert) missingFieldsAlert.style.display = "none";
    currentDraftData = null;

    setStatus("Prescription successfully saved to database!");
    
    saveHistory({
      timestamp: dbRes.timestamp || Date.now(),
      source: updatedData.source,
      patientId: dbRes.patientId || "unknown",
      patientName: updatedData.patientName,
      language: updatedData.language,
      text: updatedData.text,
      result: updatedData
    });
    
    loadPatientHistory();
    loadStats(); // Refresh hospital-wide stats after save

  } catch (error) {
    setStatus(`Failed to save: ${error.message}`, true);
  }
}

function saveHistory(record) {
  const existing = JSON.parse(localStorage.getItem(historyKey) || "[]");
  existing.unshift(record);
  localStorage.setItem(historyKey, JSON.stringify(existing.slice(0, 3)));
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
      <pre>${JSON.stringify(getCleanRecord(record.result), null, 2)}</pre>
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

async function loadStats() {
  try {
    const response = await fetch(`${BACKEND_URL}/stats`);
    if (!response.ok) return;
    const data = await response.json();
    
    if (statsRibbon) statsRibbon.style.display = "grid";
    if (statTotal) statTotal.innerText = data.todayVisits || "0";
    if (statPatients) statPatients.innerText = data.totalPatients || "0";
    if (statSymptoms) statSymptoms.innerText = (data.topSymptoms || []).join(", ");
  } catch (error) {
    console.warn("Failed to load stats:", error);
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* AI History Chat Logic */
const chatQueryInput = document.getElementById("chat-query");
const chatAnswerEl = document.getElementById("chat-answer");
const chatMicBtn = document.getElementById("chat-mic-btn");

async function toggleChatMic() {
  if (isProcessing) return;
  if (!chatIsRecording) {
    // Start Chat recording
    chatIsRecording = true;
    chatMicBtn.classList.add("pulse");
    await startListening();
  } else {
    // Stop Chat recording
    // Don't flip chatIsRecording = false yet! 
    // Wait for the mediaRecorder.onstop event to use it correctly.
    chatMicBtn.classList.remove("pulse");
    stopListening();
  }
}

async function handleChatVoiceInput(audioBlob) {
  // Now we can reset the state
  chatIsRecording = false;
  setStatus("Transcribing question...");
  try {
    const formData = new FormData();
    formData.append("audio", audioBlob);

    const response = await fetch(`${BACKEND_URL}/transcribe`, {
      method: "POST",
      body: formData
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    chatQueryInput.value = data.text;
    await askHistory();
  } catch (error) {
    setStatus(`Chat error: ${error.message}`, true);
    isProcessing = false;
  }
}

async function askHistory() {
  console.log("Chat Send button clicked!");
  const query = chatQueryInput ? chatQueryInput.value.trim() : "";
  const patientId = patientIdInput ? patientIdInput.value.trim() : "";

  console.log("Query:", query, "PatientId:", patientId);

  if (!query) {
    setStatus("Please enter or speak a question first.", true);
    return;
  }
  if (!patientId) {
    setStatus("Please select a patient first to query their history.", true);
    return;
  }

  isProcessing = true;
  if (chatAnswerEl) {
    chatAnswerEl.style.display = "block";
    chatAnswerEl.innerHTML = "<em>AI is thinking...</em>";
  }
  setStatus("AI is reviewing patient history...");

  try {
    const response = await fetch(`${BACKEND_URL}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, question: query })
    });

    console.log("Response status:", response.status);
    const data = await response.json();
    console.log("AI Answer:", data.answer);

    if (!response.ok) throw new Error(data.error || "AI Assistant could not fetch history.");

    if (chatAnswerEl) {
      chatAnswerEl.innerText = data.answer || "No answer returned.";
    }
    setStatus("AI Assistant ready.");
  } catch (error) {
    console.error("Chat Error:", error);
    if (chatAnswerEl) {
      chatAnswerEl.innerHTML = `<span style="color: #ef4444;">Error: ${error.message}</span>`;
    }
    setStatus(`Chatbot failed: ${error.message}`, true);
  } finally {
    isProcessing = false;
  }
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
