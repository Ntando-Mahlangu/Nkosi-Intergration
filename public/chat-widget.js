/**
 * LeadRecovery embeddable chat widget. Paste onto your own website as:
 *   <script src="https://<your-leadrecovery-host>/chat-widget.js"
 *           data-tenant="<tenantId>" data-form-key="<formKey>"></script>
 * `formKey` is Tenant.publicFormKey — safe to publish (see
 * src/routes/publicChat.ts's own doc comment for why). Talks only to
 * /public/chat/:tenantId/* on the same host this script was loaded from.
 */
(function () {
  "use strict";

  var scriptEl = document.currentScript;
  if (!scriptEl) return;
  var tenantId = scriptEl.getAttribute("data-tenant");
  var formKey = scriptEl.getAttribute("data-form-key");
  if (!tenantId || !formKey) {
    console.error("LeadRecovery chat widget: data-tenant and data-form-key are both required.");
    return;
  }
  var base = new URL(scriptEl.src).origin;
  var storageKey = "leadrecovery_chat_" + tenantId;

  function loadSession() {
    try {
      var raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null; // private browsing / blocked storage — the widget still works, just can't resume across reloads
    }
  }
  function saveSession(session) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(session));
    } catch (e) {
      // ignore — see loadSession
    }
  }
  function clearSession() {
    try {
      localStorage.removeItem(storageKey);
    } catch (e) {
      // ignore
    }
  }

  function api(path, options) {
    return fetch(base + path, {
      method: options && options.method ? options.method : "GET",
      headers: { "Content-Type": "application/json" },
      body: options && options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || res.status + " " + res.statusText);
        return body;
      });
    });
  }

  // --- Styles (scoped under #leadrecovery-chat-widget to avoid colliding with the host page) ---
  var style = document.createElement("style");
  style.textContent =
    "#leadrecovery-chat-widget{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:Georgia,'Times New Roman',serif;}" +
    "#leadrecovery-chat-widget .lrcw-button{width:56px;height:56px;border-radius:50%;background:#14171f;color:#eee7d8;border:1px solid rgba(201,168,117,0.4);cursor:pointer;font-size:24px;box-shadow:0 4px 16px rgba(0,0,0,0.3);}" +
    "#leadrecovery-chat-widget .lrcw-panel{display:none;flex-direction:column;position:fixed;bottom:86px;right:20px;width:320px;max-width:calc(100vw - 40px);height:440px;max-height:calc(100vh - 140px);background:#14171f;color:#eee7d8;border:1px solid rgba(201,168,117,0.3);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.4);overflow:hidden;}" +
    "#leadrecovery-chat-widget .lrcw-panel.lrcw-open{display:flex;}" +
    "#leadrecovery-chat-widget .lrcw-header{padding:12px 14px;border-bottom:1px solid rgba(201,168,117,0.2);font-size:13px;letter-spacing:0.05em;display:flex;justify-content:space-between;align-items:center;}" +
    "#leadrecovery-chat-widget .lrcw-close{cursor:pointer;background:none;border:none;color:#8b8677;font-size:16px;}" +
    "#leadrecovery-chat-widget .lrcw-thread{flex:1;overflow-y:auto;padding:10px;font-size:13px;line-height:1.4;}" +
    "#leadrecovery-chat-widget .lrcw-bubble{max-width:80%;padding:7px 10px;border-radius:8px;margin-bottom:8px;white-space:pre-wrap;}" +
    "#leadrecovery-chat-widget .lrcw-bubble.lrcw-inbound{background:#c9a875;color:#14171f;margin-left:auto;}" +
    "#leadrecovery-chat-widget .lrcw-bubble.lrcw-outbound{background:#1b1e27;border:1px solid rgba(201,168,117,0.2);}" +
    "#leadrecovery-chat-widget .lrcw-form{padding:10px;border-top:1px solid rgba(201,168,117,0.2);display:flex;flex-direction:column;gap:6px;}" +
    "#leadrecovery-chat-widget input,#leadrecovery-chat-widget textarea{background:#1b1e27;border:1px solid rgba(201,168,117,0.3);color:#eee7d8;border-radius:6px;padding:6px 8px;font-size:13px;font-family:inherit;}" +
    "#leadrecovery-chat-widget .lrcw-row{display:flex;gap:6px;}" +
    "#leadrecovery-chat-widget .lrcw-row input{flex:1;}" +
    "#leadrecovery-chat-widget button.lrcw-send{background:#c9a875;color:#14171f;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-weight:bold;}" +
    "#leadrecovery-chat-widget .lrcw-error{color:#e08080;font-size:11px;min-height:14px;}";
  document.head.appendChild(style);

  // --- DOM ---
  var root = document.createElement("div");
  root.id = "leadrecovery-chat-widget";
  root.innerHTML =
    '<button type="button" class="lrcw-button" aria-label="Open chat">💬</button>' +
    '<div class="lrcw-panel" role="dialog" aria-label="Chat">' +
    '<div class="lrcw-header"><span>Chat with us</span><button type="button" class="lrcw-close" aria-label="Close chat">✕</button></div>' +
    '<div class="lrcw-thread"></div>' +
    '<div class="lrcw-form"></div>' +
    '<div class="lrcw-error"></div>' +
    "</div>";
  document.body.appendChild(root);

  var button = root.querySelector(".lrcw-button");
  var panel = root.querySelector(".lrcw-panel");
  var thread = root.querySelector(".lrcw-thread");
  var formArea = root.querySelector(".lrcw-form");
  var errorEl = root.querySelector(".lrcw-error");

  function showError(message) {
    errorEl.textContent = message || "";
  }

  function appendBubble(direction, body) {
    var bubble = document.createElement("div");
    bubble.className = "lrcw-bubble lrcw-" + direction;
    bubble.textContent = body;
    thread.appendChild(bubble);
    thread.scrollTop = thread.scrollHeight;
  }

  function renderMessageForm(session) {
    formArea.innerHTML =
      '<div class="lrcw-row">' +
      '<input type="text" class="lrcw-input" placeholder="Type a message…" />' +
      '<button type="button" class="lrcw-send">Send</button>' +
      "</div>";
    var input = formArea.querySelector(".lrcw-input");
    var sendBtn = formArea.querySelector(".lrcw-send");

    function send() {
      var text = input.value.trim();
      if (!text) return;
      showError("");
      input.value = "";
      appendBubble("inbound", text);
      api("/public/chat/" + tenantId + "/message", {
        method: "POST",
        body: { formKey: formKey, leadId: session.leadId, chatToken: session.chatToken, body: text },
      })
        .then(function (reply) {
          appendBubble("outbound", reply.displayText);
        })
        .catch(function (err) {
          showError("Could not send: " + err.message);
        });
    }
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") send();
    });
    input.focus();
  }

  function renderStartForm() {
    formArea.innerHTML =
      '<input type="text" class="lrcw-name" placeholder="Your name (optional)" />' +
      '<input type="text" class="lrcw-contact" placeholder="Phone or email (optional)" />' +
      '<button type="button" class="lrcw-send">Start chat</button>';
    var nameInput = formArea.querySelector(".lrcw-name");
    var contactInput = formArea.querySelector(".lrcw-contact");
    var startBtn = formArea.querySelector(".lrcw-send");

    startBtn.addEventListener("click", function () {
      showError("");
      var contact = contactInput.value.trim();
      var isEmail = contact.indexOf("@") !== -1;
      api("/public/chat/" + tenantId + "/start", {
        method: "POST",
        body: {
          formKey: formKey,
          name: nameInput.value.trim() || undefined,
          phone: contact && !isEmail ? contact : undefined,
          email: contact && isEmail ? contact : undefined,
        },
      })
        .then(function (session) {
          saveSession(session);
          renderMessageForm(session);
        })
        .catch(function (err) {
          showError("Could not start chat: " + err.message);
        });
    });
  }

  function resumeOrStart() {
    var session = loadSession();
    if (!session) {
      renderStartForm();
      return;
    }
    api(
      "/public/chat/" +
        tenantId +
        "/history?formKey=" +
        encodeURIComponent(formKey) +
        "&leadId=" +
        encodeURIComponent(session.leadId) +
        "&chatToken=" +
        encodeURIComponent(session.chatToken)
    )
      .then(function (history) {
        thread.innerHTML = "";
        history.forEach(function (m) {
          appendBubble(m.direction, m.body);
        });
        renderMessageForm(session);
      })
      .catch(function () {
        // Session no longer valid (e.g. tenant rotated something) — start fresh rather than getting stuck.
        clearSession();
        renderStartForm();
      });
  }

  var initialized = false;
  button.addEventListener("click", function () {
    panel.classList.toggle("lrcw-open");
    if (panel.classList.contains("lrcw-open") && !initialized) {
      initialized = true;
      resumeOrStart();
    }
  });
  root.querySelector(".lrcw-close").addEventListener("click", function () {
    panel.classList.remove("lrcw-open");
  });
})();
