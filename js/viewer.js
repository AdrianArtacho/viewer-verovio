/* =========================================================
   Harmony Viewer – HTML analysis overlay (global baseline)
   ========================================================= */

"use strict";

/* ---------- URL params ---------- */
const params = new URLSearchParams(window.location.search);

const SCORE_URL = params.get("score");
const DEBUG = params.get("debug") === "yes";
const TITLE = params.get("title") || "";

/* analysis.json defaults next to score */
function defaultAnalysisUrl(scoreUrl) {
  if (!scoreUrl) return null;
  try {
    const u = new URL(scoreUrl, window.location.href);
    u.hash = "";
    u.pathname = u.pathname.replace(/\.(musicxml|xml)$/i, ".json");
    return u.toString();
  } catch {
    return scoreUrl.replace(/\.(musicxml|xml)$/i, ".json");
  }
}

const ANALYSIS_URL = params.get("analysis") || defaultAnalysisUrl(SCORE_URL);

/* MIDI config */
const CC_SELECT = Number(params.get("ccSelect") || 22); // select step (0 clears)
const CC_COUNT  = Number(params.get("ccCount")  || 23); // step count
const CC_SLIDE  = Number(params.get("ccSlide")  || 24); // slide index

const MIDI_IN_NAME  = params.get("midiIn")  || "Max→Browser";
const MIDI_OUT_NAME = params.get("midiOut") || "Browser→Max";

/* ---------- DOM ---------- */
const scoreDiv = document.getElementById("score");
const titleDiv = document.getElementById("title");
const debugControls = document.getElementById("debug-controls");
const debugBtn = document.getElementById("nextBtn");

const viewerDiv = document.getElementById("viewer");
const overlay = document.getElementById("analysis-overlay");
const overlayStufe = overlay.querySelector(".analysis-stufe");
const overlayFunc  = overlay.querySelector(".analysis-function");

/* ---------- UI ---------- */
if (TITLE) {
  titleDiv.textContent = TITLE;
  titleDiv.hidden = false;
} else {
  titleDiv.hidden = true;
}

debugControls.hidden = !DEBUG;

/* ---------- Guard ---------- */
if (!SCORE_URL) {
  console.error("No score= parameter provided");
  alert("No score= parameter provided");
  throw new Error("No score= parameter provided");
}

if (typeof verovio === "undefined") {
  console.error("Verovio toolkit not loaded (verovio is undefined)");
  alert("Verovio toolkit not loaded (verovio is undefined)");
  throw new Error("Verovio toolkit not loaded (verovio is undefined)");
}

/* ---------- Verovio ---------- */
const vrv = new verovio.toolkit();
vrv.setOptions({
  scale: 40,
  pageWidth: 3000,
  pageHeight: 2000,
  adjustPageHeight: true,
  spacingStaff: 12,
  spacingSystem: 18
});

/* ---------- State ---------- */
let steps = [];            // array of arrays of NOTEHEAD <use> elements
let currentStep = 0;

let analysisData = null;   // normalized to { steps:[...] }

let midiIn = null;
let midiOut = null;
let stepsReady = false;
let midiReady  = false;

/* global baseline in VIEWER pixel coordinates */
let globalBaselineY = null;

/* =========================================================
   Load score
   ========================================================= */
fetch(SCORE_URL)
  .then(r => {
    if (!r.ok) throw new Error("Failed to load score: " + SCORE_URL);
    return r.text();
  })
  .then(async xml => {
    vrv.loadData(xml);

    renderScore();
    extractStepsChordSafe();

    await loadAnalysis();

    stepsReady = true;
    if (DEBUG) console.log("Total harmonic steps:", steps.length);

    initMIDI();

    // default: highlight nothing
    highlightStep(0);

    // settle layout -> size + (re)position overlay if needed
    requestAnimationFrame(() => {
      notifyParentOfHeight();
      repositionOverlayForCurrentStep();
    });
  })
  .catch(err => {
    console.error(err);
    alert(err.message);
  });

/* =========================================================
   Load analysis JSON (optional) + normalize
   ========================================================= */
async function loadAnalysis() {
  analysisData = null;
  if (!ANALYSIS_URL) {
    if (DEBUG) console.log("No analysis URL (analysis disabled).");
    return;
  }

  try {
    const r = await fetch(ANALYSIS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const raw = await r.json();
    analysisData = Array.isArray(raw) ? { steps: raw } : raw;

    if (!analysisData?.steps || !Array.isArray(analysisData.steps)) {
      console.warn("Analysis JSON shape unexpected. Expected {steps:[...]} or [...].");
      analysisData = null;
      return;
    }

    if (DEBUG) console.log("Loaded analysis JSON:", analysisData);
  } catch (e) {
    if (DEBUG) console.log("No analysis JSON / failed:", ANALYSIS_URL, e);
    analysisData = null;
  }
}

/* =========================================================
   Render + iframe resize
   ========================================================= */
function renderScore() {
  scoreDiv.innerHTML = vrv.renderToSVG(1);
}

function notifyParentOfHeight() {
  const svg = scoreDiv.querySelector("svg");
  if (!svg) return;

  let height = document.body.scrollHeight;
  try {
    const bbox = svg.getBBox();
    height = Math.ceil(bbox.y + bbox.height) + 60; // some padding for overlay text
  } catch {}

  window.parent?.postMessage({ type: "harmony-resize", height }, "*");
}

window.addEventListener("resize", () => {
  // If the viewer resizes (Reveal, fullscreen, etc), baseline must be recomputed
  globalBaselineY = null;
  fitScoreToViewerWidth();
  repositionOverlayForCurrentStep();
  notifyParentOfHeight();
});

/* =========================================================
   Step extraction (CHORD-SAFE)
   A step is:
   1) <g class="chord">  (atomic)
   2) OR a standalone <g class="note"> not inside a chord
   ========================================================= */
function extractStepsChordSafe() {
  steps = [];

  const svg = scoreDiv.querySelector("svg");
  if (!svg) return;

  const chordGroups = Array.from(svg.querySelectorAll("g.chord"));
  const standaloneNotes = Array.from(svg.querySelectorAll("g.note"))
    .filter(note => !note.closest("g.chord"));

  const allSteps = [...chordGroups, ...standaloneNotes].sort((a, b) => {
    if (a === b) return 0;
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  allSteps.forEach(el => {
    const noteheads = el.querySelectorAll(".notehead use");
    if (noteheads.length > 0) steps.push([...noteheads]);
  });
}

/* =========================================================
   Highlighting (SVG noteheads)
   ========================================================= */
function clearHighlight() {
  scoreDiv.querySelectorAll(".hv-highlight").forEach(el => {
    el.classList.remove("hv-highlight");
    el.removeAttribute("fill");
    el.removeAttribute("color");
  });
}

function highlightStep(index) {
  if (DEBUG) console.log("[highlightStep]", index);

  clearHighlight();

  if (index <= 0 || index > steps.length) {
    currentStep = 0;
    hideOverlay();
    return;
  }

  const useEls = steps[index - 1];
  useEls.forEach(u => {
    u.classList.add("hv-highlight");
    u.setAttribute("fill", "#d00");
    u.setAttribute("color", "#d00");
  });

  currentStep = index;
  updateOverlayForStep(index);
}

/* =========================================================
   HTML overlay (global baseline)
   ========================================================= */
function hideOverlay() {
  overlay.hidden = true;
  overlay.classList.remove("active");
  overlay.classList.add("inactive");
}

function updateOverlayForStep(index) {
  if (!analysisData?.steps?.[index - 1]) {
    hideOverlay();
    return;
  }

  const a = analysisData.steps[index - 1];
  overlayStufe.textContent = a.stufe || "";
  overlayFunc.textContent  = a.function || "";

  overlay.hidden = false;
  overlay.classList.add("active");
  overlay.classList.remove("inactive");

  // (re)compute global baseline once (first time we show overlay)
  if (globalBaselineY === null) {
    const bbox = getStepScreenBBox(index);
    if (bbox) {
      const viewerRect = viewerDiv.getBoundingClientRect();
      globalBaselineY = (bbox.maxY - viewerRect.top) + 10;
      if (DEBUG) console.log("[analysis] computed globalBaselineY:", globalBaselineY);
    }
  }

  positionOverlayAtStep(index);
}

function repositionOverlayForCurrentStep() {
  if (currentStep > 0) {
    updateOverlayForStep(currentStep);
  }
}

/* Get step bbox in SCREEN pixels */
function getStepScreenBBox(index) {
  const useEls = steps[index - 1];
  if (!useEls || !useEls.length) return null;

  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const u of useEls) {
    const r = u.getBoundingClientRect();
    if (!isFinite(r.left) || !isFinite(r.right) || !isFinite(r.bottom)) continue;
    minX = Math.min(minX, r.left);
    maxX = Math.max(maxX, r.right);
    maxY = Math.max(maxY, r.bottom);
  }

  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(maxY)) return null;
  return { minX, maxX, maxY };
}

function positionOverlayAtStep(index) {
  const bbox = getStepScreenBBox(index);
  if (!bbox) return;

  const viewerRect = viewerDiv.getBoundingClientRect();
  const centerX = (bbox.minX + bbox.maxX) / 2;

  const xInViewer = centerX - viewerRect.left;
  const yInViewer = (globalBaselineY !== null) ? globalBaselineY : (bbox.maxY - viewerRect.top + 10);

  overlay.style.left = `${xInViewer}px`;
  overlay.style.top  = `${yInViewer}px`;

  if (DEBUG && analysisData?.steps?.[index - 1]) {
    const a = analysisData.steps[index - 1];
    console.log(`Step ${index}:`, a.stufe || "", a.function || "");
  }
}

function fitScoreToViewerWidth() {
  const svg = scoreDiv.querySelector("svg");
  if (!svg) return;

  const viewerWidth = viewerDiv.clientWidth;
  const svgBBox = svg.getBBox();

  if (!svgBBox.width || !viewerWidth) return;

  // target: leave a little margin
  const margin = 20;
  const scaleFactor = (viewerWidth - margin) / svgBBox.width;

  if (scaleFactor > 0) {
    svg.style.transformOrigin = "0 0";
    svg.style.transform = `scale(${scaleFactor})`;
  }
}


/* =========================================================
   MIDI
   ========================================================= */
function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    console.warn("Web MIDI not supported");
    return;
  }

  navigator.requestMIDIAccess().then(access => {
    // inputs
    for (const input of access.inputs.values()) {
      if (input.name.includes(MIDI_IN_NAME)) {
        midiIn = input;
        midiIn.onmidimessage = handleMIDIIn;
        if (DEBUG) console.log("BOUND INPUT:", input.name);
      }
    }

    // outputs
    for (const output of access.outputs.values()) {
      if (output.name.includes(MIDI_OUT_NAME)) {
        midiOut = output;
        midiReady = true;
        if (DEBUG) console.log("BOUND OUTPUT:", output.name);
        maybeSendStepCount();
      }
    }

    maybeSendStepCount();
  });
}

function handleMIDIIn(e) {
  const [status, cc, value] = e.data;
  if ((status & 0xf0) !== 0xb0) return; // CC only

  if (cc === CC_SELECT) {
    // value 0 clears highlight + overlay
    highlightStep(value);
  }
}

/* Step count CC23 */
function maybeSendStepCount() {
  if (!stepsReady || !midiReady) return;
  sendStepCount();
}

function sendStepCount() {
  if (!midiOut) return;
  const value = Math.min(127, steps.length);
  midiOut.send([0xb0, CC_COUNT, value]);
  if (DEBUG) console.log(`Sent step count (CC${CC_COUNT}):`, value);
}

function sendSlideIndex(index) {
  if (!midiOut) return;
  const value = Math.max(0, Math.min(127, index));
  midiOut.send([0xb0, CC_SLIDE, value]);
  if (DEBUG) console.log(`Sent slide index (CC${CC_SLIDE}):`, value);
}

/* Debug button */
if (debugBtn) {
  debugBtn.onclick = () => {
    let next = currentStep + 1;
    if (next > steps.length) next = 1;
    highlightStep(next);
  };
}

/* =========================================================
   Reveal activation hook
   ========================================================= */
window.addEventListener("message", event => {
  const d = event.data;
  if (d && d.type === "reveal-slide-visible") {
    if (DEBUG) console.log("Reveal slide visible:", d.slideIndex);

    // slide index -> Max
    if (typeof d.slideIndex === "number") sendSlideIndex(d.slideIndex);

    // count -> Max
    maybeSendStepCount();

    // reset highlight on entry
    highlightStep(0);

    // baseline will be recomputed on first highlight
    globalBaselineY = null;

    // ensure size correct
    requestAnimationFrame(() => {
      fitScoreToViewerWidth();
      notifyParentOfHeight();
    });
  }
});
