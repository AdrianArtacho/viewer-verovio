# Verovio Harmony Viewer

An interactive, browser-based score viewer built on **Verovio**, designed for **teaching harmony** with:

- stepwise highlighting of notes / chords
- Roman-numeral & function analysis overlays
- MIDI control **from and to Max/MSP**
- seamless embedding in **Reveal.js** presentations

The viewer can run **standalone** or be **embedded** as an iframe inside Reveal slides, with automatic activation, resizing, and MIDI isolation per slide.

---

## Repository structure

```

verovio-viewer/
├── viewer/
│   ├── index.html          # Standalone Harmony Viewer
│   ├── css/
│   │   └── viewer.css      # Viewer & analysis styling
│   ├── js/
│   │   ├── viewer.js       # Core logic (Verovio, MIDI, analysis)
│   │   └── verovio-toolkit.js
│   └── plugin/
│       └── reveal-harmony.js  # Reveal.js plugin
│
├── scores/
│   ├── example.musicxml
│   └── example.json        # Optional harmonic analysis
│
└── README.md

````

---

## Features at a glance

- **MusicXML rendering** via Verovio (SVG)
- **Step-based navigation** (notes / chords grouped logically)
- **Roman numeral (Stufe) + function** overlay
- **Global analysis baseline** (all labels aligned vertically)
- **MIDI control (CC in / notes out)**
- **Reveal.js slide-aware activation**
- **Offline-capable** (local Verovio copy)

---

## Running the viewer (standalone)

### 1. Serve the folder

The viewer must be loaded via HTTP (not `file://`).

```bash
cd verovio-viewer
python3 -m http.server 8000
````

### 2. Open in browser

```url
http://localhost:8000/viewer/index.html?score=/scores/demo.musicxml
```

---

## URL parameters

The viewer is configured entirely via URL parameters.

| Parameter  | Description                             |
| ---------- | --------------------------------------- |
| `score`    | **Required.** Path to MusicXML file     |
| `debug`    | `yes` → show debug controls & logs      |
| `title`    | Optional title shown above the score    |
| `zoom`     | Optional numeric zoom override          |
| `analysis` | Optional explicit path to analysis JSON |

### Example

```url
viewer/index.html?score=/scores/example.musicxml&debug=yes&title=Perfect%20Cadence
```

---

## Harmonic analysis (optional)

If a JSON file with the **same name and path** as the MusicXML exists, it is loaded automatically.

### Example paths

```text
scores/example.musicxml
scores/example.json
```

### Analysis JSON format

```json
{
  "title": "Perfect cadence",
  "steps": [
    { "stufe": "I",  "function": "T" },
    { "stufe": "V",  "function": "D" },
    { "stufe": "I",  "function": "T" }
  ]
}
```

* One entry per harmonic step
* Steps are aligned with the internally computed chord groups
* Labels are rendered **below the score**, aligned to a **global baseline**

---

## MIDI integration

The viewer uses **Web MIDI** and communicates via **virtual MIDI ports** (e.g. macOS IAC).

### MIDI input (Max → Browser)

| CC       | Meaning                                    |
| -------- | ------------------------------------------ |
| **CC22** | Select harmonic step (0 = clear highlight) |

* Values are integers
* Step indices are **1-based** (CC22 = 1 selects first step)

### MIDI output (Browser → Max)

| Message         | Meaning                               |
| --------------- | ------------------------------------- |
| **CC23**        | Total number of harmonic steps        |
| **CC24**        | Current horizontal Reveal slide index |
| **Note On/Off** | Pitches of highlighted chord          |

* Notes are sent **only for the active viewer**
* Previous slides are muted automatically


### MIDI within Live

| Message         | Meaning                               |
| --------------- | ------------------------------------- |
| **CC25**        | CC in to highlight a specific step    |
| **CC26**        | CC out, towards META_scene            |

---

## Virtual MIDI ports (macOS example)

1. Open **Audio MIDI Setup**
2. Enable **IAC Driver**
3. Create two buses:

   * `IAC Max→Browser`
   * `IAC Browser→Max`

In Max:

* Use `notein` / `ctlin` with `IAC Browser→Max`
* Send CC22 via `ctlout` to `IAC Max→Browser`

---

## Embedding in Reveal.js

### 1. Include the plugin

In your Reveal presentation:

```html
<script src="viewer/plugin/reveal-harmony.js"></script>

<script>
Reveal.initialize({
  plugins: [ RevealHarmony ]
});
</script>
```

### 2. Embed the viewer in a slide

```html
<section>
  <iframe
    data-harmony
    src="viewer/index.html?score=/scores/example.musicxml"
    style="width:100%; border:0;">
  </iframe>
</section>
```

### What the plugin does

* Activates **only the current slide’s viewer**
* Deactivates all others (no MIDI accumulation)
* Sends the **horizontal slide index** to the viewer
* Automatically resizes iframe & slide height
* Works with fragments and vertical slides

---

## Activation model (important)

Only the **active Reveal slide**:

* responds to CC22
* sends MIDI notes
* sends CC23 / CC24

This guarantees:

* no duplicate MIDI output
* clean Max integration
* predictable teaching workflows

Standalone mode is always active.

---

## Styling & layout

* SVG scaling handled in JS (fit-to-width by default)
* Analysis overlay is **HTML**, not SVG
* Vertical baseline is computed **once per score**
* Font sizes are controlled in `viewer.css`
* Vertical spacing between Stufe and function is controlled in JS

---

## Debug mode

Enable with:

```url
&debug=yes
```

Shows:

* “Next step” button
* Zoom indicator
* Console logs for MIDI, steps, analysis, activation

Debug UI is hidden by default and in Reveal embeds.

---

## Offline use

The repository includes a local copy of:

```url
viewer/js/verovio-toolkit.js
```

No internet connection is required once served locally.

---

## Typical teaching setup

* Reveal presentation for structure
* Embedded Harmony Viewer per example
* Max patch sending CC22
* Projector / shared screen
* Live harmonic walkthrough with keyboard

---

## License / attribution

* Verovio © Verovio Project
* This viewer architecture © repository author(s)

---

## Status

This project is **stable** and suitable for:

* classroom teaching
* workshops
* lecture-performances
* research demos

Further extensions (animations, fragments, figured bass, etc.) can be layered on top without changing the core architecture.

---

## [To-Do](https://trello.com/c/YS8PzTd3/8-%F0%9F%95%B9visualise)
