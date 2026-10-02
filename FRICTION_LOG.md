# Friction log: building an Alexa+ MCP add-on

Built from October 1, 2026, on Windows 11 and an Echo Show (Alexa+ enabled on the account). Each entry: what we tried, what we expected, what happened, how we worked around it, and what would fix it.

## 1. No way to run an add-on on Alexa+ outside the partner program

- **Severity:** high (blocks testing on the real device)
- **Task:** run our MCP server as an Alexa+ add-on on our own Echo Show, as the QuickStart describes.
- **Steps:** opened developer.amazon.com/alexaplus to find how to get access.
- **Expected:** a developer preview, or a test mode limited to our own devices.
- **Actual:** "Alexa+ for Builders is currently available to select partners working directly with our team." The hackathon track does not grant access either; it allows simulating Alexa+ in a web app.
- **Workaround:** built an Echo Show style Alexa+ simulator that calls the MCP server over real MCP, and checked the MCP Apps views in two other MCP Apps hosts (Claude, ChatGPT).
- **Suggestion:** a self-serve test mode: an add-on visible only on the developer's own devices and account, without certification. Even for hackathon participants only.

## 2. The CLI from the QuickStart cannot be installed

- **Severity:** high
- **Task:** `alexa-ai configure`, `alexa-ai new mcp`, `alexa-ai deploy`.
- **Steps:** `npm install -g @alexa-ai/cli`.
- **Expected:** the CLI installs.
- **Actual:** `E404 Not Found`: the package is not in the public npm registry (it appears to live in a private registry). Checked twice on October 1. The documentation also lists only macOS and Ubuntu with Node 24+, so Windows developers would need WSL even with access.
- **Workaround:** none for deployment; we followed the written MCP Apps rules (layout, CSP, display modes) by hand.
- **Suggestion:** publish the CLI to public npm (gated at login, not at install), say in the QuickStart that it requires partner access, and support Windows or document WSL.

## 3. The Echo Show web view silently denies the microphone

- **Severity:** high for any conversational add-on; undocumented
- **Task:** let the user talk to a live video representative inside the add-on view.
- **Steps:** since we could not open an add-on view on the device (entry 1), we tested the closest thing: a web page in the Echo Show's built-in browser (Silk 138). The page called `getUserMedia({audio: true})`, then the Web Speech API, then the camera, then file input capture.
- **Expected:** a permission prompt, or a documented rule.
- **Actual:** `NotAllowedError` instantly, with no prompt; the permission state stays `prompt`; Web Speech returns `not-allowed`; input capture does nothing. Audio input devices are listed, so the API looks available. There is no microphone toggle in Silk or Echo settings. The closest official word we found is an Amazon staff answer on the developer forum to an Echo Show 15 question (April 2026): "Amazon does not provide third party apps access to certain system level permissions on our Fire tablets and Fire TV devices." The Alexa+ MCP Apps pages do not mention microphone, camera, autoplay or WebRTC at all, so we cannot tell whether an add-on view behaves the same.
- **Workaround:** Alexa stays the ears. A new tool, `ask_representative`, receives the user's words from the host and passes them into the live session; the representative answers on screen in video and voice.
- **Suggestion:** document the permission model of the add-on view (microphone, camera, autoplay with sound, WebRTC). Better: an MCP Apps capability for the host to stream recognized user speech into the view, so add-ons do not each invent a tool for it.

## 4. Opaque-origin views break backends that check `Origin`

- **Severity:** medium
- **Task:** connect the view to our existing real-time avatar service over WebSocket.
- **Steps:** read the Alexa+ layout and rendering page on how views are hosted; compared it with our avatar service's `Origin` check; in another MCP Apps host, ran a probe view that opened a WebSocket to our server and tried to embed our existing web player as a nested iframe.
- **Expected:** the view's origin is declared or predictable, so the backend can allow it.
- **Actual:** the docs specify a sandboxed iframe with an opaque origin (`Origin: null`), and only `connectDomains` and `resourceDomains` in the CSP; nested frames are not mentioned (a nested iframe did not load in our tests in another host). A backend that checks `Origin` must either accept `null` (which any page can send) or reject the add-on.
- **Workaround:** the MCP server relays the WebSocket and sets the session parameters on the server side, so the view never holds them. This moves the trust decision to our server rather than solving it: the relay itself accepts any origin, so it has to limit concurrent conversations, their length, and request rates.
- **Suggestion:** give each add-on view a stable, verifiable origin (for example, per-add-on subdomain), or a signed token from the host that a backend can verify.

## 5. Hard to tell what "Alexa+" will do with the conversation around a view

- **Severity:** low
- **Task:** decide who books: the assistant or the business's own agent.
- **Steps:** searched the Alexa+ add-on documentation for how an add-on returns a result (a booking) to Alexa and how it may receive the signed-in user's details.
- **Expected:** a documented pattern for handing an event back to Alexa's calendar, and a consent flow for sharing the user's name and phone.
- **Actual:** no guidance on how an add-on should hand results back to Alexa's own features (calendar, reminders, shopping list), or how a user profile may be shared with an add-on with consent.
- **Workaround:** `get_representative_booking` returns the confirmed booking, and the simulator's Alexa adds it to a stand-in calendar; a fixed demo profile is passed once, with the user's words.
- **Suggestion:** document a consent flow for sharing the user's name and phone with an add-on, and a standard result shape (event, order) that Alexa can save into its own features.
