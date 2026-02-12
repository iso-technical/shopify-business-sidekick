(function () {
  var scriptTag = document.currentScript;
  var shop = scriptTag && scriptTag.getAttribute("data-shop");

  console.log("[insights-ui] script loaded");
  console.log("[insights-ui] shop from data attribute:", shop);

  if (!shop) {
    console.log("[insights-ui] no shop attribute — skipping insights fetch");
    return;
  }

  var el = document.getElementById("insights");
  console.log("[insights-ui] insights element:", el);

  if (!el) {
    console.log("[insights-ui] #insights element not found — skipping");
    return;
  }

  console.log("[insights-ui] Fetching insights for shop:", shop);

  fetch("/insights?shop=" + encodeURIComponent(shop))
    .then(function (r) {
      console.log("[insights-ui] response status:", r.status);
      return r.json();
    })
    .then(function (data) {
      console.log("[insights-ui] data received:", Object.keys(data));
      if (data.error) {
        console.log("[insights-ui] error:", data.error);
        el.innerHTML = '<p class="insights-error">' + data.error + "</p>";
      } else if (data.insights) {
        console.log("[insights-ui] insights length:", data.insights.length);
        el.innerHTML =
          '<div class="insights-content">' +
          data.insights
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;") +
          "</div>";
      } else {
        console.log("[insights-ui] no insights in response");
        el.innerHTML =
          '<p class="insights-error">No insights generated.</p>';
      }
    })
    .catch(function (err) {
      console.error("[insights-ui] fetch failed:", err);
      el.innerHTML =
        '<p class="insights-error">Failed to load insights.</p>';
    });
})();
