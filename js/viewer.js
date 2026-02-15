/* =========================================================
   Harmony Viewer – Stable CC + Analysis + MIDI Notes (Verovio attr API)
   Works with older verovio-toolkit.js builds (no unsupported options).
   ========================================================= */
"use strict";

/* ---------- URL params ---------- */
const params = new URLSearchParams(window.location.search);

const SCORE_URL = params.get("score");
const DEBUG     = params.get("debug") === "yes";
const TITLE     = params.get("title") || "";
const ZOOM_PARAM = params.get("zoom") || "fit";

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

/* ---------- MIDI config ---------- */
const CC_SELECT = Number(params.get("ccSelect") || 22); // step select (0 clears)
const CC_COUNT  = Number(params.get("ccCount")  || 23); // step count
const CC_SLIDE  = Number(params.get("ccSlide")  || 24); // slide index

const MIDI_IN_NAME  = params.get("midiIn")  || "Max→Browser";
const MIDI_OUT_NAME = params.get("midiOut") || "Browser→Max";

/* Note output settings (tweakable via URL later) */
const NOTE_CH = Number(params.get("noteCh") || 1);           // 1..16
const NOTE_VEL = Number(params.get("vel") || 90);            // 1..127
const NOTE_DUR_MS = Number(params.get("dur") || 250);        // ms

/* ---------- DOM ---------- */
const viewerDiv = document.getElementById("viewer");
const scoreDiv  = document.getElementById("score");
const titleDiv  = document.getElementById("title");
const debugBtn  = document.getElementById("nextBtn");

const overlay = document.getElementById("analysis-overlay");
const overlayStufe = overlay?.querySelector(".analysis-stufe");
const overlayFunc  = overlay?.querySelector(".analysis-function");

/* ---------- Guards ---------- */
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
let steps = [];              // array of arrays of SVG <use> (noteheads)
let stepNoteIds = [];        // array of arrays of NOTE group ids (g.note id)
let stepPitches = [];        // array of arrays of MIDI pitches

let currentStep = 0;
let analysisData = null;

let midiIn = null;
let midiOut = null;

let globalBaselineY = null;  // one global baseline for analysis overlay

/* ---------- UI title ---------- */
if (titleDiv) {
  if (TITLE) {
    titleDiv.textContent = TITLE;
    titleDiv.hidden = false;
  } else {
    titleDiv.hidden = true;
  }
}

/* =========================================================
   Helpers: robust value parsing from older Verovio builds
   ========================================================= */
function asString(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return asString(v[0]);
  if (typeof v === "object") {
    if ("value" in v) return asString(v.value);
    // some emscripten wrappers return {0: "..."}
    if (0 in v) return asString(v[0]);
  }
  return null;
}

function asInt(v) {
  const s = asString(v);
  if (s === null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

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

    computeStepNoteIds();   // g.note ids per step
    computeStepPitches();   // MIDI pitches per step (via vrv.getElementAttr)

    if (DEBUG) console.log("Total harmonic steps:", steps.length);

    initMIDI();

    // default: no highlight
    highlightStep(0);

    requestAnimationFrame(() => {
      applyScoreZoom();
      notifyParentOfHeight();
      repositionOverlayForCurrentStep();
    });
  })
  .catch(err => {
    console.error(err);
    alert(err.message);
  });

/* =========================================================
   Analysis JSON
   ========================================================= */
async function loadAnalysis() {
  analysisData = null;
  if (!ANALYSIS_URL) return;

  try {
    const r = await fetch(ANALYSIS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    analysisData = Array.isArray(raw) ? { steps: raw } : raw;

    if (DEBUG) console.log("Loaded analysis JSON:", analysisData);
  } catch (e) {
    if (DEBUG) console.log("Analysis JSON not loaded:", ANALYSIS_URL, e);
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
    height = Math.ceil(bbox.y + bbox.height) + 80;
  } catch {}

  window.parent?.postMessage({ type: "harmony-resize", height }, "*");
}

window.addEventListener("resize", () => {
  globalBaselineY = null;
  applyScoreZoom();
  repositionOverlayForCurrentStep();
  notifyParentOfHeight();
});

/* =========================================================
   Step extraction (CHORD SAFE)
   Step is either:
     - <g class="chord"> (contains multiple g.note)
     - or standalone <g class="note"> not inside chord
   We store NOTEHEAD <use> arrays in `steps`.
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
   Build NOTE group ids for each step
   (IMPORTANT: do NOT use <use xlink:href>, that's a GLYPH id!)
   ========================================================= */
function computeStepNoteIds() {
  stepNoteIds = steps.map(useEls => {
    const ids = [];
    for (const u of useEls) {
      const noteGroup = u.closest("g.note");
      if (noteGroup && noteGroup.id) ids.push(noteGroup.id);
    }
    // remove duplicates within chord (can happen with multiple notehead uses)
    return Array.from(new Set(ids));
  });

  if (DEBUG) {
    for (let i = 0; i < stepNoteIds.length; i++) {
      console.log(`Step ${i + 1} noteGroup IDs:`, stepNoteIds[i]);
    }
  }
}

/* =========================================================
   Pitch extraction via Verovio internal model
   (Older Verovio: SVG doesn't carry pitch. We query vrv.getElementAttr)
   ========================================================= */
function getMidiFromNoteGroupId(noteId) {
  const attr = vrv.getElementAttr(noteId, "pname");

  if (!attr || typeof attr !== "object") return null;

  // 🔑 Your Verovio build returns everything here
  const pname = attr.pname;
  const oct   = attr.oct;

  if (typeof pname !== "string" || typeof oct !== "string") return null;

  const pcMap = { c:0, d:2, e:4, f:5, g:7, a:9, b:11 };
  const pc = pcMap[pname.toLowerCase()];
  if (pc === undefined) return null;

  const midi = (parseInt(oct, 10) + 1) * 12 + pc;
  return midi;
}


function computeStepPitches() {
  stepPitches = stepNoteIds.map((ids, idx) => {
    const pitches = [];
    for (const id of ids) {
      const m = getMidiFromNoteGroupId(id);
      if (m !== null) pitches.push(m);
    }
    if (DEBUG) console.log(`Step ${idx + 1} pitches:`, pitches);
    return pitches;
  });
}

/* =========================================================
   Highlighting
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

  // --- send MIDI notes (if we have pitches) ---
  if (midiOut) {
    const pitches = stepPitches[index - 1] || [];
    if (DEBUG) console.log(`Step ${index} -> MIDI pitches to send:`, pitches);

    const ch0 = Math.max(0, Math.min(15, NOTE_CH - 1));
    pitches.forEach(p => midiOut.send([0x90 | ch0, p & 0x7f, NOTE_VEL & 0x7f]));
    setTimeout(() => {
      pitches.forEach(p => midiOut.send([0x80 | ch0, p & 0x7f, 0]));
    }, NOTE_DUR_MS);
  }
}

/* =========================================================
   Analysis overlay (HTML, global baseline)
   ========================================================= */
function hideOverlay() {
  if (!overlay) return;
  overlay.hidden = true;
}

function updateOverlayForStep(index) {
  if (!overlay || !analysisData?.steps?.[index - 1]) {
    hideOverlay();
    return;
  }

  const a = analysisData.steps[index - 1];
  overlayStufe.textContent = a.stufe || "";
  overlayFunc.textContent  = a.function || "";

  overlay.hidden = false;

  // compute global baseline once, from the LOWEST notehead of the FIRST shown step
  if (globalBaselineY === null) {
    const bbox = getStepScreenBBox(index);
    if (bbox) {
      const viewerRect = viewerDiv.getBoundingClientRect();
      globalBaselineY = (bbox.maxY - viewerRect.top) + 12;
      if (DEBUG) console.log("[analysis] computed globalBaselineY:", globalBaselineY);
    }
  }

  positionOverlayAtStep(index);
}

function repositionOverlayForCurrentStep() {
  if (currentStep > 0) updateOverlayForStep(currentStep);
}

function getStepScreenBBox(index) {
  const useEls = steps[index - 1];
  if (!useEls || !useEls.length) return null;

  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const u of useEls) {
    const r = u.getBoundingClientRect();
    minX = Math.min(minX, r.left);
    maxX = Math.max(maxX, r.right);
    maxY = Math.max(maxY, r.bottom);
  }
  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(maxY)) return null;
  return { minX, maxX, maxY };
}

function positionOverlayAtStep(index) {
  const bbox = getStepScreenBBox(index);
  if (!bbox || !overlay) return;

  const viewerRect = viewerDiv.getBoundingClientRect();
  const centerX = (bbox.minX + bbox.maxX) / 2;

  overlay.style.left = `${centerX - viewerRect.left}px`;
  overlay.style.top  = `${globalBaselineY ?? (bbox.maxY - viewerRect.top + 12)}px`;
}

/* =========================================================
   Zoom (fit width default, manual numeric, none)
   ========================================================= */
function applyScoreZoom() {
  const svg = scoreDiv.querySelector("svg");
  if (!svg) return;

  svg.style.transformOrigin = "0 0";

  if (ZOOM_PARAM === "none") {
    svg.style.transform = "";
    return;
  }

  const manual = parseFloat(ZOOM_PARAM);
  if (!Number.isNaN(manual) && manual > 0) {
    svg.style.transform = `scale(${manual})`;
    return;
  }

  // default = fit
  const viewerWidth = viewerDiv.clientWidth;
  let svgWidth = 0;
  try { svgWidth = svg.getBBox().width; } catch { svgWidth = svg.clientWidth; }
  if (!svgWidth || !viewerWidth) return;

  const s = (viewerWidth - 20) / svgWidth;
  if (s > 0) svg.style.transform = `scale(${s})`;
}

/* =========================================================
   MIDI init
   ========================================================= */
function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    console.warn("Web MIDI not supported");
    return;
  }

  navigator.requestMIDIAccess().then(access => {
    // bind input
    for (const input of access.inputs.values()) {
      if (input.name.includes(MIDI_IN_NAME)) {
        midiIn = input;
        midiIn.onmidimessage = handleMIDIIn;
        if (DEBUG) console.log("BOUND INPUT:", input.name);
      }
    }

    // bind output
    for (const output of access.outputs.values()) {
      if (output.name.includes(MIDI_OUT_NAME)) {
        midiOut = output;
        if (DEBUG) console.log("BOUND OUTPUT:", output.name);
        sendStepCount();
      }
    }
  });
}

function handleMIDIIn(e) {
  const [status, cc, value] = e.data;
  if ((status & 0xf0) !== 0xb0) return; // CC only

  if (cc === CC_SELECT) {
    // value 0 clears
    highlightStep(value);
  }
}

function sendStepCount() {
  if (!midiOut) return;
  const value = Math.min(127, steps.length);
  midiOut.send([0xb0, CC_COUNT, value]);
  if (DEBUG) console.log(`Sent step count (CC${CC_COUNT}):`, value);
}

function sendSlideIndex(index) {
  if (!midiOut) return;
  midiOut.send([0xb0, CC_SLIDE, Math.max(0, Math.min(127, index))]);
}

/* Debug button if present */
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

    if (typeof d.slideIndex === "number") sendSlideIndex(d.slideIndex);

    sendStepCount();
    highlightStep(0);
    globalBaselineY = null;

    requestAnimationFrame(() => {
      applyScoreZoom();
      notifyParentOfHeight();
    });
  }
});
