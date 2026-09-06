// Run before the body is parsed, independent of React or the service connection.
if (new URLSearchParams(window.location.search).get("kiosk") === "1") {
  document.documentElement.dataset.kiosk = "true";
}
