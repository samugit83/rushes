---
name: Framework support
about: Rushes could not drive your app's shape
labels: framework
---

**The shape**

Not the framework's name — the behaviour that broke. For example: "the first
document is empty and the content arrives over a websocket", or "every route
change is a full page load that takes four seconds".

**Which condition never became true**

`readiness/timeout` names it. Paste the diagnostic.

**What you tried**

`readiness.busySelector`? `readySelector`? A higher `quietMs`?

**Can you contribute a fixture?**

The conformance suite takes a ~60-line server that reproduces the shape. That is
what turns "works with any framework" from a claim into a test.
