// The Android half of window.virtuShell (client/src/shell.md). Injected at
// document start on the app origin only (ShellBridge.kt), where it wraps the
// origin-allowlisted WebMessageListener port (window.virtuShellPort) into the
// uniform promise-based request() the web app compiles against. Requests and
// replies are correlated by an internal id the web side never sees.
//
// The shell-version placeholder below is substituted with the app
// versionName at attach time (its only occurrence in this file).
(function () {
  "use strict";
  if (window.virtuShell) return;
  var port = window.virtuShellPort;
  if (!port) return; // no port injected: behave as plain web

  var pending = new Map();
  var nextId = 1;

  port.onmessage = function (event) {
    var envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    var resolve = pending.get(envelope.id);
    if (resolve) {
      pending.delete(envelope.id);
      resolve(envelope.reply);
    }
  };

  window.virtuShell = {
    platform: "android",
    shellVersion: "__SHELL_VERSION__",
    protocol: 1,
    request: function (message) {
      return new Promise(function (resolve, reject) {
        if (typeof message !== "string") {
          reject(new TypeError("virtuShell.request takes a JSON string"));
          return;
        }
        var id = nextId++;
        pending.set(id, resolve);
        try {
          port.postMessage(JSON.stringify({ id: id, message: message }));
        } catch (e) {
          pending.delete(id);
          reject(e);
        }
      });
    },
  };
})();
