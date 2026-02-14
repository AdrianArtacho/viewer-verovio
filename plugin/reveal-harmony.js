/*!
 * Reveal Harmony Plugin
 * Sends activation messages ONLY to harmony iframes
 * in the currently active slide.
 *
 * Classic script (no ES modules)
 */

(function () {

  const RevealHarmony = {
    id: "reveal-harmony",

    init: function (reveal) {
      console.log("[RevealHarmony] plugin initialized");

      function notifySlide(slide) {
        if (!slide) return;

        // Only harmony iframes INSIDE the current slide
        const iframes = slide.querySelectorAll("iframe[data-harmony]");
        if (!iframes.length) return;

        iframes.forEach(iframe => {
          if (!iframe.contentWindow) return;

          iframe.contentWindow.postMessage(
            { type: "reveal-slide-visible" },
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

  // 👇 THIS is what Reveal v4 needs
  window.RevealHarmony = RevealHarmony;

})();
