/* =========================================================
   Harmony Viewer – viewer.js (chord-safe + no scrollbars)
   ========================================================= */

"use strict";

/* ---------- URL params ---------- */
const params = new URLSearchParams(window.location.search);

const SCORE_URL = params.get("score");
const DEBUG = params.get("debug") === "yes";
const TITLE = params.get("title") || "";

/* MIDI config */
const CC_SELECT = Number(params.get("ccSelect") || 22); // select step
const CC_COUNT  = Number(params.get("ccCount")  || 23); // step count

const MIDI_IN_NAME  = params.get("midiIn")  || "Max→Browser";
const MIDI_OUT_NAME = params.get("midiOut") || "Browser→Max";

/* ---------- DOM ---------- */
const scoreDiv = document.getElementById("score");
const titleDiv = document.getElementById("title");
const debugControls = document.getElementById("debug-controls");
const debugBtn = document.getElementById("nextBtn");

/* ---------- UI ---------- */
if (TITLE) {
  titleDiv.textContent = TITLE;
  titleDiv.hidden = false;
} else {
  titleDiv.hidden = true;
}

if (DEBUG) {
  debugControls.hidden = false;
} else {
  debugControls.hidden = true;
}

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

/* IMPORTANT:
   - removed ignoreLayout (your build doesn't support it)
   - keep options conservative + supported
*/
vrv.setOptions({
  scale: 40,
  pageWidth: 3000,
  pageHeight: 2000,
  adjustPageHeight: true,
  spacingStaff: 12,
  spacingSystem: 18
});

/* ---------- State ---------- */
let steps = [];          // array of arrays of NOTEHEAD <use> elements
let currentStep = 0;

let midiIn = null;
let midiOut = null;

let stepsReady = false;
let midiReady  = false;

/* =========================================================
   Load score
   ========================================================= */
fetch(SCORE_URL)
  .then(r => {
    if (!r.ok) throw new Error("Failed to load score: " + SCORE_URL);
    return r.text();
  })
  .then(xml => {
    vrv.loadData(xml);

    renderScore();
    extractStepsChordSafe();

    stepsReady = true;
    if (DEBUG) console.log("Total harmonic steps:", steps.length);

    initMIDI();

    // default state: nothing highlighted
    highlightStep(0);

    // resize once more after layout settles
    requestAnimationFrame(() => {
      requestAnimationFrame(() => notifyParentOfHeight());
    });
  })
  .catch(err => {
    console.error(err);
    alert(err.message);
  });

/* =========================================================
   Render + iframe resize
   ========================================================= */
function renderScore() {
  scoreDiv.innerHTML = vrv.renderToSVG(1);
  notifyParentOfHeight();
}

function notifyParentOfHeight() {
  const svg = scoreDiv.querySelector("svg");
  if (!svg) return;

  // bbox is in SVG units; height here matches rendered content better than scrollHeight
  let height = 0;
  try {
    const bbox = svg.getBBox();
    height = Math.ceil(bbox.y + bbox.height);
  } catch {
    // fallback
    height = document.body.scrollHeight;
  }

  // also force the viewer to be non-scrollable internally
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";

  window.parent?.postMessage({ type: "harmony-resize", height }, "*");
}

window.addEventListener("resize", () => {
  notifyParentOfHeight();
});

/* =========================================================
   Step extraction (CHORD-SAFE) – restores your correct logic
   =========================================================
   A step is:
   1) a <g class="chord"> (atomic)
   2) OR a standalone <g class="note"> that is NOT inside a chord
*/
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
    if (noteheads.length > 0) {
      steps.push([...noteheads]);
    }
  });
}

/* =========================================================
   Highlighting
   ========================================================= */
const HIGHLIGHT_COLOR = "#d00"; // red-ish

function clearHighlight() {
  // remove class + explicit attributes (both, for robustness across SVG styles)
  scoreDiv.querySelectorAll(".hv-highlight").forEach(el => {
    el.classList.remove("hv-highlight");
    el.removeAttribute("fill");
    el.removeAttribute("color");
  });
}

function highlightStep(index) {
  clearHighlight();

  if (index <= 0 || index > steps.length) {
    currentStep = 0;
    return;
  }

  const useEls = steps[index - 1];
  useEls.forEach(u => {
    u.classList.add("hv-highlight");
    // make it work even when CSS isn't applied to <use>
    u.setAttribute("fill", HIGHLIGHT_COLOR);
    u.setAttribute("color", HIGHLIGHT_COLOR);
  });

  currentStep = index;
}

/* inject tiny CSS for highlight (SVG + safety) */
(function injectHighlightCSS() {
  const style = document.createElement("style");
  style.textContent = `
    .hv-highlight { fill: ${HIGHLIGHT_COLOR} !important; color: ${HIGHLIGHT_COLOR} !important; }
  `;
  document.head.appendChild(style);
})();

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
    for (let input of access.inputs.values()) {
      if (input.name.includes(MIDI_IN_NAME)) {
        midiIn = input;
        midiIn.onmidimessage = handleMIDIIn;
        if (DEBUG) console.log("BOUND INPUT:", input.name);
      }
    }

    // outputs
    for (let output of access.outputs.values()) {
      if (output.name.includes(MIDI_OUT_NAME)) {
        midiOut = output;
        midiReady = true;
        if (DEBUG) console.log("BOUND OUTPUT:", output.name);
        maybeSendStepCount();
      }
    }

    if (!midiOut && DEBUG) console.warn("No MIDI OUT found matching:", MIDI_OUT_NAME);
    if (!midiIn  && DEBUG) console.warn("No MIDI IN found matching:", MIDI_IN_NAME);

    // Even if MIDI isn't ready yet, steps might be ready — try anyway.
    maybeSendStepCount();
  });
}

function handleMIDIIn(e) {
  const [status, cc, value] = e.data;
  if ((status & 0xf0) !== 0xb0) return; // only CC

  if (cc === CC_SELECT) {
    // value 0 clears highlight
    highlightStep(value);
  }
}

/* =========================================================
   Step count CC23 – on load + on Reveal slide visible
   ========================================================= */
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

/* =========================================================
   Debug button
   ========================================================= */
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

  // your plugin sends { type: 'reveal-slide-visible' }
  if (d && d.type === "reveal-slide-visible") {
    if (DEBUG) console.log("Reveal says slide visible → resend CC count + resize");
    maybeSendStepCount();
    highlightStep(0);           // reset highlight on entry
    notifyParentOfHeight();     // ensure iframe gets correct height
  }
});
