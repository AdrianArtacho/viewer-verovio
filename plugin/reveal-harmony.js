/* Reveal.js plugin: Harmony Viewer integration
   - Activates ONLY the iframe on the current slide
   - Deactivates all other Harmony iframes (prevents MIDI accumulation)
   - Auto-resizes iframe AND slide section correctly
*/

(function () {
  window.RevealHarmony = {
    id: "harmony",

    init: function (deck) {
      console.log("[RevealHarmony] plugin initialized");

      /* -------------------------------------------------
         CSS hard overrides (Reveal normally fights this)
      ------------------------------------------------- */
      const style = document.createElement("style");
      style.textContent = `
        .reveal,
        .reveal .slides {
          overflow: visible !important;
        }

        .reveal section {
          overflow: visible !important;
        }

        iframe[data-harmony] {
          width: 100% !important;
          border: 0 !important;
          outline: 0 !important;
          box-shadow: none !important;
          background: transparent !important;
          display: block;
        }

        section[data-harmony-slide] {
          display: block !important;
        }
      `;
      document.head.appendChild(style);

      /* -------------------------------------------------
         Helpers
      ------------------------------------------------- */
      function getHarmonyIframes() {
        return Array.from(document.querySelectorAll("iframe[data-harmony]"));
      }

      function computeSlideIndex(event) {
        // Prefer event indices if available
        if (event && typeof event.indexh === "number") {
          const h = event.indexh;
          const v = typeof event.indexv === "number" ? event.indexv : 0;
          return h * 100 + v;
        }

        // Fallback to deck state
        const indices = deck.getIndices();
        const h = indices.h || 0;
        const v = indices.v || 0;
        return h * 100 + v;
      }

      function activateCurrentIframe(event) {
        const current = deck.getCurrentSlide();
        const slideIndex = computeSlideIndex(event);

        for (const iframe of getHarmonyIframes()) {
          if (!iframe.contentWindow) continue;

          const isActive = current && current.contains(iframe);

          iframe.contentWindow.postMessage(
            {
              type: isActive ? "harmony-activate" : "harmony-deactivate",
              slideIndex
            },
            "*"
          );

          const section = iframe.closest("section");
          if (section) {
            if (isActive) {
              section.setAttribute("data-harmony-slide", "true");
            } else {
              section.removeAttribute("data-harmony-slide");
            }
          }
        }
      }

      /* -------------------------------------------------
         Reveal lifecycle hooks
      ------------------------------------------------- */
      deck.on("ready", (event) => activateCurrentIframe(event));
      deck.on("slidechanged", (event) => activateCurrentIframe(event));
      deck.on("fragmentshown", (event) => activateCurrentIframe(event));
      deck.on("fragmenthidden", (event) => activateCurrentIframe(event));

      /* -------------------------------------------------
         Resize handling from viewer
      ------------------------------------------------- */
      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type !== "harmony-resize") return;

        const iframe = getHarmonyIframes().find(
          (f) => f.contentWindow === event.source
        );
        if (!iframe) return;

        const height = Number(msg.height);
        if (!height || height <= 0) return;

        // Resize iframe
        iframe.style.height = `${height}px`;

        // Resize section
        const section = iframe.closest("section");
        if (section) {
          section.style.height = `${height}px`;
          section.style.minHeight = `${height}px`;
          section.style.maxHeight = "none";
          section.style.overflow = "visible";
          section.style.transform = "none";
        }

        if (typeof deck.layout === "function") {
          deck.layout();
        }
      });
    }
  };
})();
