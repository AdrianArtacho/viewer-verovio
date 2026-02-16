/* viewer.js — Harmony Viewer (drop-in)
   - Verovio render + chord-step grouping
   - Analysis JSON overlay (HTML elements, does NOT touch SVG)
   - WebMIDI:
       IN  (CC22): step index (1..N, 0 clears)
       OUT (CC23): total steps (sent on activate + on load)
       OUT (CC24): slide index (sent when Reveal tells us)
       OUT (notes): pitches of current step (note-ons burst)
   - Embeds:
       harmony-activate / harmony-deactivate via postMessage
       reveal-slide-visible via postMessage (index)
       viewer-height via postMessage back to parent
*/

(() => {
  "use strict";

  // ---------------------------
  // URL params / flags
  // ---------------------------
  const params = new URLSearchParams(window.location.search);
  const SCORE_URL = params.get("score") || "";
  const TITLE = params.get("title") || "";
  const DEBUG = (params.get("debug") || "").toLowerCase() === "yes";

  // zoom param:
  //   zoom=fit (default)
  //   zoom=0.85 (manual)
  const zoomParamRaw = params.get("zoom");
  const ZOOM_MODE =
    zoomParamRaw === null || zoomParamRaw === "" || zoomParamRaw.toLowerCase() === "fit"
      ? "fit"
      : "manual";
  const MANUAL_ZOOM =
    ZOOM_MODE === "manual" ? Math.max(0.2, Math.min(4, Number(zoomParamRaw))) : null;

  // Optional port overrides:
  //   in=...
  //   out=...
  const IN_PORT_HINT = params.get("in") || "max->browser";
  const OUT_PORT_HINT = params.get("out") || "browser->max";

  const IS_EMBEDDED = window.self !== window.top;

  // ---------------------------
  // DOM
  // ---------------------------
  const elTitle = document.getElementById("title");
  const elDebugControls = document.getElementById("debug-controls");
  const elNextBtn = document.getElementById("nextBtn");
  const elViewer = document.getElementById("viewer");
  const elScore = document.getElementById("score");
  const elOverlay = document.getElementById("analysis-overlay");
  const elStufe = elOverlay ? elOverlay.querySelector(".analysis-stufe") : null;
  const elFunc = elOverlay ? elOverlay.querySelector(".analysis-function") : null;
  const elZoomIndicator = document.getElementById("zoom-indicator");

  if (TITLE && elTitle) {
    elTitle.textContent = TITLE;
    elTitle.hidden = false;
  }
  if (DEBUG) {
    if (elDebugControls) elDebugControls.hidden = false;
    if (elZoomIndicator) elZoomIndicator.hidden = false;
  }

  // ---------------------------
  // State
  // ---------------------------
  let vrvToolkit = null;

  // harmonicSteps: Array< Array<noteGroupIdString> >
  let harmonicSteps = [];
  let highlightedStep = 0;

  // analysis JSON: { title, steps:[ { stufe, function, ... }, ... ] }
  let analysis = null;
  let globalAnalysisBaselineY = null;


  // activation gating (important for embeds!)
  let isActiveViewer = !IS_EMBEDDED; // standalone = active by default
  let currentSlideIndex = 0;

  // MIDI
  let midiAccess = null;
  let midiIn = null;
  let midiOut = null;

  // group->pitches cache (computed from Verovio)
  // stepPitches[stepIndex-1] = [midiPitch,...]
  let stepPitches = [];

  // ---------------------------
  // Utilities
  // ---------------------------
  function clampInt(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, Math.trunc(n)));
  }

  function cssEscape(id) {
    // Minimal escape for querySelector
    return (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, "\\$1");
  }

  function log(...a) {
    if (DEBUG) console.log(...a);
  }

  function warn(...a) {
    console.warn(...a);
  }

  function normalizePortName(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[→➔⇒]/g, "->")
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9<>\-_.]/g, "");
  }

  function pickMidiPort(mapLike, hint) {
    const ports = Array.from(mapLike.values());
    if (ports.length === 0) return null;

    const hintNorm = normalizePortName(hint);

    // 1) direct normalized substring match
    let p = ports.find((x) => normalizePortName(x.name).includes(hintNorm));
    if (p) return p;

    // 2) arrow-insensitive heuristic: look for browser/max keywords
    const hn = hintNorm;
    const wantsBrowser = hn.includes("browser");
    const wantsMax = hn.includes("max");
    if (wantsBrowser || wantsMax) {
      p = ports.find((x) => {
        const n = normalizePortName(x.name);
        return (!wantsBrowser || n.includes("browser")) && (!wantsMax || n.includes("max"));
      });
      if (p) return p;
    }

    // 3) fallback: first available
    return ports[0];
  }

  // ---------------------------
  // Height reporting to Reveal wrapper
  // ---------------------------
  function notifyParentOfHeight() {
    if (!IS_EMBEDDED) return;
    if (!elViewer) return;

    const height = elViewer.offsetHeight;
    window.parent.postMessage({ type: "viewer-height", height }, "*");
  }

  // ---------------------------
  // Verovio render + fit
  // ---------------------------
  function ensureToolkit() {
    if (vrvToolkit) return vrvToolkit;

    // Verovio is expected to be global from ./js/verovio-toolkit.js
    if (typeof verovio === "undefined" || !verovio.toolkit) {
      throw new Error("Verovio toolkit not found. Make sure verovio-toolkit.js is loaded.");
    }
    vrvToolkit = new verovio.toolkit();

    // Keep options conservative (your build complained about unsupported options before)
    vrvToolkit.setOptions({
      scale: 40,          // will be overridden by fit/manual zoom logic
      pageWidth: 2000,     // large canvas, then we fit by CSS transform
      pageHeight: 2000,
      adjustPageHeight: true,
      breaks: "none",
      header: "none",
      footer: "none",
      // DO NOT use ignoreLayout/addMidiData/svgAdditionalAttributes etc (unsupported in your build)
    });

    return vrvToolkit;
  }

  function applySvgFitToContainer() {
    const svgEl = elScore.querySelector("svg");
    if (!svgEl) return;

    // make SVG behave like a measurable block
    svgEl.style.display = "block";
    svgEl.style.transformOrigin = "0 0";

    const container = elViewer; // viewer wraps score + overlay
    const scoreBox = elScore;

    const containerW = container.clientWidth || 1;
    const containerH = container.clientHeight || 1;

    // Use the SVG's viewBox / bbox
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal ? svgEl.viewBox.baseVal : null;
    let svgW = vb ? vb.width : (svgEl.getBBox ? svgEl.getBBox().width : svgEl.clientWidth);
    let svgH = vb ? vb.height : (svgEl.getBBox ? svgEl.getBBox().height : svgEl.clientHeight);
    if (!svgW || !svgH) {
      // fallback to bounding client rect
      const r = svgEl.getBoundingClientRect();
      svgW = r.width || 1;
      svgH = r.height || 1;
    }

    // Fit-to-width default (and keep within height as much as possible)
    let scale = 1;
    if (ZOOM_MODE === "manual" && MANUAL_ZOOM) {
      scale = MANUAL_ZOOM;
    } else {
      scale = containerW / svgW;
      // If it becomes too tall, soften by height
      const scaledH = svgH * scale;
      if (scaledH > containerH && containerH > 0) {
        scale = Math.min(scale, containerH / svgH);
      }
    }

    // Center horizontally if smaller than container after scaling
    const scaledW = svgW * scale;
    const scaledH = svgH * scale;

    const left = Math.max(0, (containerW - scaledW) / 2);
    const top = 0; // keep top aligned (important for embeds)

    svgEl.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;

    // keep scoreBox height big enough so overlay positions can use offsets
    scoreBox.style.minHeight = `${scaledH}px`;

    if (DEBUG && elZoomIndicator) {
      elZoomIndicator.textContent = `zoom=${scale.toFixed(3)} (${ZOOM_MODE}${ZOOM_MODE === "manual" ? `:${MANUAL_ZOOM}` : ""})`;
      elZoomIndicator.hidden = false;
    }
  }

  // ---------------------------
  // Harmonic step detection (group noteheads into chords)
  // ---------------------------
  function buildHarmonicStepsFromSvg() {
    const svgEl = elScore.querySelector("svg");
    if (!svgEl) return [];

    // Heuristic:
    // Verovio outputs <g class="note" id="..."> ... <g class="notehead"> ...
    // If multiple notes belong to a chord at the same time position, they tend to appear adjacent.
    // We'll group by x position (rounded) of the notehead.
    const noteGroups = Array.from(svgEl.querySelectorAll("g.note[id]"));

    // Extract X coordinate from first child <use> in notehead (best available stable geometry in your SVG)
    const entries = [];
    for (const g of noteGroups) {
      const id = g.getAttribute("id");
      const use = g.querySelector("g.notehead use");
      if (!use) continue;

      const tr = use.getAttribute("transform") || "";
      // transform="translate(2568, 1440) scale(0.72,0.72)"
      const m = tr.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
      const x = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(x)) continue;

      entries.push({ id, x });
    }

    // sort left to right
    entries.sort((a, b) => a.x - b.x);

    // group by rounded x bucket
    const buckets = new Map(); // bucketX -> [ids]
    const BUCKET = 3; // px-ish in Verovio units (tweakable)
    for (const e of entries) {
      const k = Math.round(e.x / BUCKET);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(e.id);
    }

    const steps = Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, ids]) => ids);

    return steps;
  }

  // ---------------------------
  // Analysis JSON
  // ---------------------------
  function inferJsonUrlFromScoreUrl(scoreUrl) {
    // /scores/demo.musicxml -> /scores/demo.json
    try {
      const u = new URL(scoreUrl, window.location.href);
      const path = u.pathname;
      const jsonPath = path.replace(/\.[^/.]+$/, ".json");
      u.pathname = jsonPath;
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      return scoreUrl.replace(/\.[^/.]+$/, ".json");
    }
  }

  async function loadAnalysisIfPresent(scoreUrl) {
    const jsonUrl = inferJsonUrlFromScoreUrl(scoreUrl);
    try {
      const r = await fetch(jsonUrl, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      if (DEBUG) console.log("Loaded analysis JSON:", j);
      return j;
    } catch {
      return null;
    }
  }

  function updateAnalysisOverlay(stepIndex) {
    if (!elOverlay || !elStufe || !elFunc) return;

    if (!analysis || !analysis.steps || stepIndex <= 0) {
      elOverlay.hidden = true;
      return;
    }

    const step = analysis.steps[stepIndex - 1];
    if (!step) {
      elOverlay.hidden = true;
      return;
    }

    elStufe.textContent = step.stufe || "";
    elFunc.textContent = step.function || "";

    const svg = elScore.querySelector("svg");
    const viewerRect = elViewer.getBoundingClientRect();

    const ids = harmonicSteps[stepIndex - 1] || [];
    const rects = [];

    for (const id of ids) {
      const g = svg.querySelector(`#${cssEscape(id)}`);
      if (!g) continue;
      rects.push(g.getBoundingClientRect());
    }

    if (!rects.length) {
      elOverlay.hidden = true;
      return;
    }

    // Horizontal center of the chord
    const cx =
      rects.reduce((s, r) => s + (r.left + r.right) / 2, 0) / rects.length;

    // Use your global baseline Y (already computed elsewhere)
    if (!globalAnalysisBaselineY) {
      elOverlay.hidden = true;
      return;
    }

    const baselineY = globalAnalysisBaselineY;


    // Convert screen → viewer coordinates
    const left = cx - viewerRect.left;
    const top = baselineY - viewerRect.top + 6;

    elOverlay.style.left = `${left}px`;
    elOverlay.style.top = `${top}px`;
    elOverlay.hidden = false;
  }

  function computeGlobalAnalysisBaselineY() {
    const svg = elScore.querySelector("svg");
    if (!svg) return null;

    const noteheads = svg.querySelectorAll(".notehead, g.note");
    let maxBottom = -Infinity;

    for (const nh of noteheads) {
      const rect = nh.getBoundingClientRect();
      if (rect.bottom > maxBottom) {
        maxBottom = rect.bottom;
      }
    }

    if (!isFinite(maxBottom)) return null;

    // Padding below the lowest notehead (adjust if needed)
    return maxBottom + 10;
  }



  // ---------------------------
  // SVG highlight (CSS class on note groups)
  // ---------------------------
  function applySvgHighlight(stepIndex) {
    const svgEl = elScore.querySelector("svg");
    if (!svgEl) return;

    svgEl.querySelectorAll(".hv-highlight").forEach((n) => n.classList.remove("hv-highlight"));
    if (stepIndex <= 0) return;

    const ids = harmonicSteps[stepIndex - 1] || [];
    for (const id of ids) {
      const g = svgEl.querySelector(`#${cssEscape(id)}`);
      if (g) g.classList.add("hv-highlight");
    }
  }

  function highlightStep(stepIndex) {
    highlightedStep = clampInt(stepIndex, 0, harmonicSteps.length);
    if (DEBUG) console.log("[highlightStep]", highlightedStep);

    applySvgHighlight(highlightedStep);
    updateAnalysisOverlay(highlightedStep);

    // Only the ACTIVE viewer sends notes
    if (isActiveViewer && highlightedStep > 0) {
      sendStepNotesAsMidi(highlightedStep);
    } else {
      sendAllNotesOff();
    }

    notifyParentOfHeight();
  }

  // ---------------------------
  // Pitch computation (reliable with your Verovio build)
  // Uses vrvToolkit.getElementAttr(noteId) -> returns object with pname/oct etc
  // ---------------------------
  function pnameToSemitone(pname) {
    // pname is "c d e f g a b"
    switch (String(pname).toLowerCase()) {
      case "c": return 0;
      case "d": return 2;
      case "e": return 4;
      case "f": return 5;
      case "g": return 7;
      case "a": return 9;
      case "b": return 11;
      default: return null;
    }
  }

  function midiFromPnameOct(pname, oct) {
    const semi = pnameToSemitone(pname);
    if (semi === null) return null;
    const o = Number(oct);
    if (!Number.isFinite(o)) return null;

    // MEI oct is scientific (C4 = 60)
    // MIDI: C4 = 60 => (oct+1)*12 + semi
    return (o + 1) * 12 + semi;
  }

  function computeStepPitches() {
    if (!vrvToolkit) return;

    stepPitches = harmonicSteps.map((ids, idx) => {
      const pitches = [];
      for (const noteId of ids) {
        try {
          const attr = vrvToolkit.getElementAttr(noteId);
          // Your build returns an object with keys: pname, oct, etc.
          const pname = attr && (attr.pname || (attr.pitch && attr.pitch.pname) || attr["pname"]);
          const oct = attr && (attr.oct || (attr.pitch && attr.pitch.oct) || attr["oct"]);

          const midi = midiFromPnameOct(pname, oct);
          if (Number.isFinite(midi)) pitches.push(midi);
        } catch (e) {
          // ignore missing
        }
      }
      // unique + sorted
      const uniq = Array.from(new Set(pitches)).sort((a, b) => a - b);
      if (DEBUG) console.log(`Step ${idx + 1} pitches:`, uniq);
      return uniq;
    });
  }

  // ---------------------------
  // MIDI (WebMIDI)
  // ---------------------------
  function sendCC(cc, value, channel = 0) {
    if (!midiOut) return;
    const v = clampInt(value, 0, 127);
    const status = 0xb0 | (channel & 0x0f);
    midiOut.send([status, cc & 0x7f, v]);
  }

  function sendStepCountCc() {
    if (!isActiveViewer) return;

    const count = harmonicSteps.length;
    sendCC(23, count);

    if (DEBUG) console.log("Sent step count (CC23):", count);
  }


  function sendSlideIndexCc(index) {
    if (!isActiveViewer) return;
    // CC24: slide index (0..127)
    sendCC(24, index);
    if (DEBUG) console.log("Sent slide index (CC24):", index);
  }

  function sendAllNotesOff(channel = 0) {
    if (!midiOut) return;
    // CC123 (All Notes Off)
    sendCC(123, 0, channel);
  }

  function sendStepNotesAsMidi(stepIndex) {
    if (!midiOut) return;
    const pitches = stepPitches[stepIndex - 1] || [];
    if (DEBUG) console.log(`Step ${stepIndex} -> MIDI pitches to send:`, pitches);

    // note-on burst
    const vel = 100;
    const ch = 0;
    for (const p of pitches) {
      const pitch = clampInt(p, 0, 127);
      midiOut.send([0x90 | ch, pitch, vel]);
    }

    // short note length then All Notes Off
    window.setTimeout(() => {
      // only active viewer keeps outputting; but always cleanup
      sendAllNotesOff(ch);
    }, 80);
  }

  function handleMidiMessage(ev) {
    if (!isActiveViewer && IS_EMBEDDED) return; 

    const data = ev.data || [];
    const status = data[0] || 0;
    const d1 = data[1] || 0;
    const d2 = data[2] || 0;

    const msgType = status & 0xf0;

    // CC only
    if (msgType === 0xb0) {
      const cc = d1 & 0x7f;
      const value = d2 & 0x7f;

      // CC22 = step index (0..N)
      if (cc === 22) {
        // value 0 clears; 1..N selects
        const step = clampInt(value, 0, harmonicSteps.length);
        highlightStep(step);
      }
    }
  }

  async function initMidi() {
    if (!navigator.requestMIDIAccess) {
      warn("WebMIDI not supported in this browser.");
      return;
    }

    midiAccess = await navigator.requestMIDIAccess({ sysex: false });

    // Pick ports robustly
    midiIn = pickMidiPort(midiAccess.inputs, IN_PORT_HINT);
    midiOut = pickMidiPort(midiAccess.outputs, OUT_PORT_HINT);

    if (DEBUG) {
      console.log(
        "MIDI inputs:",
        Array.from(midiAccess.inputs.values()).map((p) => p.name)
      );
      console.log(
        "MIDI outputs:",
        Array.from(midiAccess.outputs.values()).map((p) => p.name)
      );
    }

    if (midiIn) {
      midiIn.onmidimessage = handleMidiMessage;
      console.log("BOUND INPUT:", midiIn.name);
    } else {
      warn("No MIDI input port found.");
    }

    if (midiOut) {
      console.log("BOUND OUTPUT:", midiOut.name);
    } else {
      warn("No MIDI output port found.");
    }
  }

  // ---------------------------
  // Debug controls
  // ---------------------------
  function wireDebug() {
    if (!elNextBtn) return;
    elNextBtn.addEventListener("click", () => {
      const next = highlightedStep + 1 > harmonicSteps.length ? 0 : highlightedStep + 1;
      highlightStep(next);
    });
  }

  // ---------------------------
  // postMessage interface for Reveal wrapper
  // ---------------------------
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "harmony-activate") {
      isActiveViewer = true;

      // ✅ READ slideIndex HERE
      currentSlideIndex = clampInt(msg.slideIndex ?? 0, 0, 127);

      if (DEBUG) {
        console.log("[viewer] ACTIVATED, slide:", currentSlideIndex);
      }

      sendStepCountCc();
      sendSlideIndexCc(currentSlideIndex);
      highlightStep(highlightedStep);
      notifyParentOfHeight();
      return;
    }


    if (msg.type === "harmony-deactivate") {
      isActiveViewer = false;
      log("[viewer] deactivated");
      sendAllNotesOff();
      return;
    }

    if (msg.type === "harmony-request-step-count") {
      // parent can request CC23 resend (only if active)
      sendStepCountCc();
      return;
    }
  });

  // ---------------------------
  // Main load
  // ---------------------------
  async function loadAndRender(scoreUrl) {
    if (!scoreUrl) {
      elScore.textContent = "No score URL provided (?score=...)";
      return;
    }

    const tk = ensureToolkit();

    // Load score
    const resp = await fetch(scoreUrl, { cache: "no-store" });
    if (!resp.ok) throw new Error(`Failed to fetch score: ${resp.status}`);
    const xml = await resp.text();

    tk.loadData(xml);

    // Render SVG
    const svg = tk.renderToSVG(1);
    elScore.innerHTML = svg;

    // ⏱ IMPORTANT: wait until SVG is actually in the DOM
    requestAnimationFrame(async () => {

      // Build steps + pitches (NOW the SVG is queryable)
      harmonicSteps = buildHarmonicStepsFromSvg();
      console.log("Total harmonic steps:", harmonicSteps.length);

      computeStepPitches();

      // Load analysis JSON if present
      analysis = await loadAnalysisIfPresent(scoreUrl);

      // Initial highlight
      highlightStep(0);

      // ✅ Standalone activation
      if (!IS_EMBEDDED) {
        isActiveViewer = true;
      }

      // ✅ CC23 now always has the correct value
      sendStepCountCc();

      // Fit first (important!)
      applySvgFitToContainer();

      // ✅ Compute ONE shared baseline AFTER fit
      globalAnalysisBaselineY = computeGlobalAnalysisBaselineY();

      if (DEBUG) {
        console.log("[analysis] global baseline Y:", globalAnalysisBaselineY);
      }

      notifyParentOfHeight();

    });
  }


  // Resize handling
  window.addEventListener("resize", () => {
    applySvgFitToContainer();
    notifyParentOfHeight();
  });

  // Start
  (async () => {
    try {
      wireDebug();
      await initMidi();
      await loadAndRender(SCORE_URL);
    } catch (e) {
      console.error(e);
      elScore.textContent = String(e && e.message ? e.message : e);
    }
  })();
})();
