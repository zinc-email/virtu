// The iOS half of window.virtuShell (client/src/shell.md). Injected as a
// document-start WKUserScript on the app origin (ShellBridge.swift). The
// promise returned by webkit.messageHandlers.virtuShell.postMessage IS the
// reply channel (WKScriptMessageHandlerWithReply), so unlike Android there
// is no id-correlation plumbing at all.
//
// The shell-version placeholder below is substituted with the app version
// at attach time (its only occurrence in this file).
(function () {
  "use strict";
  if (window.virtuShell) return;
  var handler =
    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.virtuShell;
  if (!handler) return; // no handler installed: behave as plain web

  window.virtuShell = {
    platform: "ios",
    shellVersion: "__SHELL_VERSION__",
    protocol: 1,
    request: function (message) {
      if (typeof message !== "string") {
        return Promise.reject(new TypeError("virtuShell.request takes a JSON string"));
      }
      return handler.postMessage(message);
    },
  };
})();
