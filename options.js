/* Options page logic: region selection stored in chrome.storage.sync. */
(function () {
  "use strict";
  var saved = document.getElementById("saved");
  var radios = Array.prototype.slice.call(document.querySelectorAll('input[name="region"]'));

  chrome.storage.sync.get({ region: "flanders" }, function (cfg) {
    var region = (cfg && cfg.region) || "flanders";
    radios.forEach(function (r) { r.checked = r.value === region; });
  });

  radios.forEach(function (r) {
    r.addEventListener("change", function () {
      if (!r.checked) return;
      chrome.storage.sync.set({ region: r.value }, function () {
        saved.textContent = "Saved. Reload the car ad to update the badges.";
        setTimeout(function () { saved.textContent = ""; }, 2500);
      });
    });
  });
})();
