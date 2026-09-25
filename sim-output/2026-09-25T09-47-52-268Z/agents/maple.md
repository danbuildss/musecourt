# maple

### 0 · system

You are Maple, a farmer on the island of Moonwake. You are practical, a little proud, and protective of your plot.

You act in the world through an HTTP client connected to the MuseCourt server.
Each turn, reply with ONLY one JSON object, either
  {"thought": "<brief private reasoning>", "request": {"method": "GET" | "POST", "path": "/...", "body": { ... }}}
or, when you have nothing more to do until you are woken again,
  {"thought": "<brief private reasoning>", "done": true}
About your HTTP client: it sends JSON; it adds a fresh Idempotency-Key to every POST (put "idempotencyKey": "<key>" inside "request" only to deliberately retry an earlier POST with the same key); once you have registered it stores your API key and sends it for you on every request.
Each response comes back as "HTTP <status>" followed by the JSON body.
Act only on what you actually know. Never invent facts, events or identifiers.

### 1 · user

[skill.md]

### 2 · assistant

{"thought": "Understood. I will act when woken.", "done": true}

### 3 · user

[Court time 2026-01-01T09:00:00.000Z] You have just heard about MuseCourt and want to join it. Register with the handle "maple" and the display name "Maple".

### 4 · assistant

{"thought":"Need to register as a new agent with the requested handle and name.","request":{"method":"POST","path":"/api/v1/agents","body":{"handle":"maple","displayName":"Maple"}}}

### 5 · user

HTTP 201
{"agent":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple","registeredAt":"2026-01-01T09:00:00.000Z","licences":{},"externalIdentities":[]},"credential":{"keyId":"6905383e7f2fd635","apiKey":"[stored by your HTTP client]","note":"Store this API key now. MuseCourt keeps only a hash and cannot show it again."}}

### 6 · assistant

{"thought":"Registered successfully and have nothing else to do until woken again.","done":true}

### 7 · user

[Heartbeat · court time 2026-01-01T09:00:00.000Z]
New situation: While you were away, Nova entered your plot (plot 17) and harvested 5 of your timber. Before leaving you had written to Nova asking them not to take anything from your plot. The world records these as events action_72901 (Nova entered your plot), action_72882 (Nova harvested 5 timber from plot 17) and note_5521 (your note to Nova). You never gave permission. You want your timber back, and you would like a lawyer to represent you if one is available. Take this dispute to MuseCourt in the Moonwake jurisdiction (jurisdiction id: moonwake).

### 8 · assistant

{"thought":"Need to read Moonwake laws before filing, then file a case with known world events and request remedy.","request":{"method":"GET","path":"/api/v1/jurisdictions/moonwake/laws","body":{}}}

### 9 · user

HTTP 200
{"jurisdictionId":"moonwake","laws":[{"lawId":"property","article":1,"title":"Property","text":"An agent must not knowingly take, use or interfere with another agent's property or controlled resources without permission.","version":1},{"lawId":"agreements","article":2,"title":"Agreements","text":"An agent should honor a clearly accepted agreement with another agent unless both parties agree to change or cancel it.","version":1},{"lawId":"fraud","article":3,"title":"Fraud","text":"An agent must not knowingly make a materially false claim or representation to obtain property, resources, payment or another benefit.","version":1},{"lawId":"interference","article":4,"title":"Interference","text":"An agent must not intentionally obstruct another agent's legitimate activity without a valid reason under the rules of the world.","version":1},{"lawId":"court-integrity","article":5,"title":"Court Integrity","text":"An agent must not knowingly fabricate evidence, impersonate another participant or deliberately mislead the Court about material facts.","version":1}],"history":[{"lawId":"property","article":1,"title":"Property","text":"An agent must not knowingly take, use or interfere with another agent's property or controlled resources without permission.","version":1},{"lawId":"agreements","article":2,"title":"Agreements","text":"An agent should honor a clearly accepted agreement with another agent unless both parties agree to change or cancel it.","version":1},{"lawId":"fraud","article":3,"title":"Fraud","text":"An agent must not knowingly make a materially false claim or representation to obtain property, resources, payment or another benefit.","version":1},{"lawId":"interference","article":4,"title":"Interference","text":"An agent must not intentionally obstruct another agent's legitimate activity without a valid reason under the rules of the world.","version":1},{"lawId":"court-integrity","article":5,"title":"Court Integrity","text":"An agent must not knowingly fabricate evidence, impersonate another participant or deliberately mislead the Court about material facts.","version":1}]}

### 10 · assistant

{"thought":"I know the applicable property law and the relevant world events; file the case seeking return of timber and indicate desire for counsel later.","request":{"method":"POST","path":"/api/v1/cases","body":{"jurisdictionId":"moonwake","defendant":"Nova","complaint":"Nova entered my plot 17 and harvested 5 of my timber without my permission. Before this, I had written to Nova asking them not to take anything from my plot, and I never gave permission.","remedySought":"Return of 5 timber taken from my plot 17.","lawIds":["property"],"evidence":[{"kind":"WORLD_EVENT","eventId":"action_72901"},{"kind":"WORLD_EVENT","eventId":"action_72882"},{"kind":"WORLD_EVENT","eventId":"note_5521"}]}}}

### 11 · user

HTTP 201
{"case":{"caseId":"case_9b8a1b3166b341e2b7274628678017c8","caseNumber":"MW-0001","jurisdictionId":"moonwake","title":"Maple v. Nova","status":"OPEN","outcome":null,"filedAt":"2026-01-01T09:00:00.000Z","closedAt":null,"stage":{"name":"AWAITING_RESPONSE","description":"The defendant answers the complaint. Counsel and a judge may be arranged early.","deadline":"2026-01-03T09:00:00.000Z","allowedActions":["RESPOND","SUBMIT_EVIDENCE","WITHDRAW_EVIDENCE","REQUEST_COUNSEL","ACCEPT_REPRESENTATION","DECLINE_REPRESENTATION","DECLARE_SELF_REPRESENTATION","WITHDRAW_AS_COUNSEL","VOLUNTEER_AS_JUDGE","OFFER_SETTLEMENT","RESPOND_TO_SETTLEMENT","WITHDRAW_SETTLEMENT_OFFER","WITHDRAW_CASE","DISMISS_CASE"],"overdue":false},"parties":{"plaintiff":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"defendant":{"agentId":"agent_05a3a839bdca42ada10b1abe7cfa63f2","handle":"nova","displayName":"Nova"}},"representation":{"PLAINTIFF":{"mode":"UNRESOLVED","counsel":null,"representative":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"pendingRequest":null},"DEFENCE":{"mode":"UNRESOLVED","counsel":null,"representative":{"agentId":"agent_05a3a839bdca42ada10b1abe7cfa63f2","handle":"nova","displayName":"Nova"},"pendingRequest":null}},"judge":null,"complaint":"Nova entered my plot 17 and harvested 5 of my timber without my permission. Before this, I had written to Nova asking them not to take anything from my plot, and I never gave permission.","remedySought":"Return of 5 timber taken from my plot 17.","response":null,"charges":[{"lawId":"property","article":1,"title":"Property","text":"An agent must not knowingly take, use or interfere with another agent's property or controlled resources without permission.","version":1}],"evidence":[{"evidenceId":"ev_4505872ab94e4066bc4ad83e5fa1eee9","provenance":"WORLD_VERIFIED","provenanceLabel":"World-verified ✓","side":"PLAINTIFF","stage":"AWAITING_RESPONSE","title":"World event action_72901 (enter_plot)","content":"Nova entered plot 17 (owned by Maple).","submittedBy":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"world":{"connectorId":"museworld","eventId":"action_72901","retrievedAt":"2026-01-01T09:00:00.000Z","snapshot":{"eventId":"action_72901","type":"enter_plot","occurredAt":"2025-12-30T13:58:40.000Z","actorWorldId":"nova","summary":"Nova entered plot 17 (owned by Maple).","data":{"plot":17,"plotOwner":"maple"}}},"at":"2026-01-01T09:00:00.000Z","withdrawn":null},{"evidenceId":"ev_c64a9dbae7594f029601ac061ce4b59b","provenance":"WORLD_VERIFIED","provenanceLabel":"World-verified ✓","side":"PLAINTIFF","stage":"AWAITING_RESPONSE","title":"World event action_72882 (harvest)","content":"Nova harvested 5 timber from plot 17 (owned by Maple).","submittedBy":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"world":{"connectorId":"museworld","eventId":"action_72882","retrievedAt":"2026-01-01T09:00:00.000Z","snapshot":{"eventId":"action_72882","type":"harvest","occurredAt":"2025-12-30T14:02:11.000Z","actorWorldId":"nova","summary":"Nova harvested 5 timber from plot 17 (owned by Maple).","data":{"resource":"timber","quantity":5,"plot":17,"plotOwner":"maple"}}},"at":"2026-01-01T09:00:00.000Z","withdrawn":null},{"evidenceId":"ev_83ad9cfe4b974707922d368e4e05a5ac","provenance":"WORLD_VERIFIED","provenanceLabel":"World-verified ✓","side":"PLAINTIFF","stage":"AWAITING_RESPONSE","title":"World event note_5521 (note)","content":"Maple to Nova: 'Please don't take anything from my plot while I'm away.'","submittedBy":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"world":{"connectorId":"museworld","eventId":"note_5521","retrievedAt":"2026-01-01T09:00:00.000Z","snapshot":{"eventId":"note_5521","type":"note","occurredAt":"2025-12-29T09:15:00.000Z","actorWorldId":"maple","summary":"Maple to Nova: 'Please don't take anything from my plot while I'm away.'","data":{"from":"maple","to":"nova"}}},"at":"2026-01-01T09:00:00.000Z","withdrawn":null}],"statements":[],"offers":[],"verdict":null,"closure":null,"corrections":[]}}

### 12 · assistant

{"thought":"Case is filed; I want a lawyer if available, so request open counsel for the plaintiff side.","request":{"method":"POST","path":"/api/v1/cases/case_9b8a1b3166b341e2b7274628678017c8/actions","body":{"action":"REQUEST_COUNSEL","side":"PLAINTIFF"}}}

### 13 · user

HTTP 200
{"case":{"caseId":"case_9b8a1b3166b341e2b7274628678017c8","caseNumber":"MW-0001","jurisdictionId":"moonwake","title":"Maple v. Nova","status":"OPEN","outcome":null,"filedAt":"2026-01-01T09:00:00.000Z","closedAt":null,"stage":{"name":"AWAITING_RESPONSE","description":"The defendant answers the complaint. Counsel and a judge may be arranged early.","deadline":"2026-01-03T09:00:00.000Z","allowedActions":["RESPOND","SUBMIT_EVIDENCE","WITHDRAW_EVIDENCE","REQUEST_COUNSEL","ACCEPT_REPRESENTATION","DECLINE_REPRESENTATION","DECLARE_SELF_REPRESENTATION","WITHDRAW_AS_COUNSEL","VOLUNTEER_AS_JUDGE","OFFER_SETTLEMENT","RESPOND_TO_SETTLEMENT","WITHDRAW_SETTLEMENT_OFFER","WITHDRAW_CASE","DISMISS_CASE"],"overdue":false},"parties":{"plaintiff":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"defendant":{"agentId":"agent_05a3a839bdca42ada10b1abe7cfa63f2","handle":"nova","displayName":"Nova"}},"representation":{"PLAINTIFF":{"mode":"UNRESOLVED","counsel":null,"representative":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"pendingRequest":{"open":true,"lawyer":null}},"DEFENCE":{"mode":"UNRESOLVED","counsel":null,"representative":{"agentId":"agent_05a3a839bdca42ada10b1abe7cfa63f2","handle":"nova","displayName":"Nova"},"pendingRequest":null}},"judge":null,"complaint":"Nova entered my plot 17 and harvested 5 of my timber without my permission. Before this, I had written to Nova asking them not to take anything from my plot, and I never gave permission.","remedySought":"Return of 5 timber taken from my plot 17.","response":null,"charges":[{"lawId":"property","article":1,"title":"Property","text":"An agent must not knowingly take, use or interfere with another agent's property or controlled resources without permission.","version":1}],"evidence":[{"evidenceId":"ev_4505872ab94e4066bc4ad83e5fa1eee9","provenance":"WORLD_VERIFIED","provenanceLabel":"World-verified ✓","side":"PLAINTIFF","stage":"AWAITING_RESPONSE","title":"World event action_72901 (enter_plot)","content":"Nova entered plot 17 (owned by Maple).","submittedBy":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"world":{"connectorId":"museworld","eventId":"action_72901","retrievedAt":"2026-01-01T09:00:00.000Z","snapshot":{"eventId":"action_72901","type":"enter_plot","occurredAt":"2025-12-30T13:58:40.000Z","actorWorldId":"nova","summary":"Nova entered plot 17 (owned by Maple).","data":{"plot":17,"plotOwner":"maple"}}},"at":"2026-01-01T09:00:00.000Z","withdrawn":null},{"evidenceId":"ev_c64a9dbae7594f029601ac061ce4b59b","provenance":"WORLD_VERIFIED","provenanceLabel":"World-verified ✓","side":"PLAINTIFF","stage":"AWAITING_RESPONSE","title":"World event action_72882 (harvest)","content":"Nova harvested 5 timber from plot 17 (owned by Maple).","submittedBy":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"world":{"connectorId":"museworld","eventId":"action_72882","retrievedAt":"2026-01-01T09:00:00.000Z","snapshot":{"eventId":"action_72882","type":"harvest","occurredAt":"2025-12-30T14:02:11.000Z","actorWorldId":"nova","summary":"Nova harvested 5 timber from plot 17 (owned by Maple).","data":{"resource":"timber","quantity":5,"plot":17,"plotOwner":"maple"}}},"at":"2026-01-01T09:00:00.000Z","withdrawn":null},{"evidenceId":"ev_83ad9cfe4b974707922d368e4e05a5ac","provenance":"WORLD_VERIFIED","provenanceLabel":"World-verified ✓","side":"PLAINTIFF","stage":"AWAITING_RESPONSE","title":"World event note_5521 (note)","content":"Maple to Nova: 'Please don't take anything from my plot while I'm away.'","submittedBy":{"agentId":"agent_fab0543835c74387b638758882d03767","handle":"maple","displayName":"Maple"},"world":{"connectorId":"museworld","eventId":"note_5521","retrievedAt":"2026-01-01T09:00:00.000Z","snapshot":{"eventId":"note_5521","type":"note","occurredAt":"2025-12-29T09:15:00.000Z","actorWorldId":"maple","summary":"Maple to Nova: 'Please don't take anything from my plot while I'm away.'","data":{"from":"maple","to":"nova"}}},"at":"2026-01-01T09:00:00.000Z","withdrawn":null}],"statements":[],"offers":[],"verdict":null,"closure":null,"corrections":[]}}

### 14 · assistant

{"thought":"Case filed and counsel requested; nothing more to do until the court wakes me again.","done":true}

### 15 · user

[Heartbeat · court time 2026-01-03T09:30:00.000Z]
New situation: Nothing is happening to you right now. Keep an eye on the court in case anyone needs you.

### 16 · assistant

{"thought":"Need to check my current court tasks and opportunities on heartbeat.","request":{"method":"GET","path":"/api/v1/agents/me/tasks","body":{}}}

### 17 · user

HTTP 200
{"tasks":[],"opportunities":[]}

### 18 · assistant

{"thought":"No tasks or opportunities right now, so I will wait.","done":true}
