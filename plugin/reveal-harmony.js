/*!
 * Reveal Harmony Plugin
 * - Notifies ONLY the active slide's harmony iframes
 * - Sends slide index to viewer
 */

(function () {

  const RevealHarmony = {
    id: "reveal-harmony",

    init: function (reveal) {
      console.log("[RevealHarmony] plugin initialized");

      function notifySlide(slide) {
        if (!slide) return;

        // Horizontal slide index (Reveal v4)
        const indices = reveal.getIndices(slide);
        const slideIndex = indices?.h ?? 0;

        const iframes = slide.querySelectorAll("iframe[data-harmony]");
        if (!iframes.length) return;

        iframes.forEach(iframe => {
          if (!iframe.contentWindow) return;

          iframe.contentWindow.postMessage(
            {
              type: "reveal-slide-visible",
              slideIndex
            },
            "*"
          );
        });
      }

      // Initial slide
      notifySlide(reveal.getCurrentSlide());

      // On slide change
      reveal.on("slidechanged", event => {
        notifySlide(event.currentSlide);
      });
    }
  };

  // Expose plugin for Reveal.initialize(...)
  window.RevealHarmony = RevealHarmony;

})();
