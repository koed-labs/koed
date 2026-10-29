---
"@koed/desktop": patch
---

- The message box now shows which AI is answering, for example "Codex · gpt-6.1-sol · Low", instead of a bare "Auto".
- In Solo, conversations no longer carry a "Just me" lock, since nothing can be shared there; only shared conversations will be marked.
- At startup the app checks every half second whether Koed's local API already answers and opens your Chief of Staff as soon as it does, instead of waiting for the first full status check, which can take tens of seconds on a busy Mac.
