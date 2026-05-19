# Koed Self-Hosted

Koed Self-Hosted is the product context for running Koed memory capture, recall, and inspection on infrastructure controlled by the operator.

## Language

**Koed Self-Hosted**:
The source-available Koed distribution for self-managed memory infrastructure.
_Avoid_: Koed Cloud, hosted Koed, open-source Koed

**Operator**:
The person or organization responsible for running a Koed Self-Hosted deployment.
_Avoid_: Customer, tenant, account

**Operator Console**:
The local UI used to create API tokens for users and track Koed Self-Hosted system status.
_Avoid_: Console, dashboard, admin app

**User**:
A human account authenticated inside a Koed Self-Hosted deployment.
_Avoid_: Account, customer, operator

**API Token**:
A user-owned credential used by an AI-client integration to access Koed.
_Avoid_: AI key, provider key, password

**Team**:
A sharing group inside a Koed Self-Hosted deployment whose members can contribute to and retrieve shared memory.
_Avoid_: Tenant, workspace, organization, operator

**Project**:
A codebase or working directory boundary used to group memory.
_Avoid_: Workspace, repository, folder

**Conversation**:
An AI-client interaction thread whose activity may be captured.
_Avoid_: Thread, chat, transcript

**Captured Session**:
Koed's record of memory capture for a conversation.
_Avoid_: Conversation, thread, transcript

**AI Client**:
An external AI tool that produces conversations and may call Koed for capture or recall.
_Avoid_: MCP server, model provider, assistant

**Supported AI Client Integration**:
An AI-client integration that supports both automatic capture through a capture hook and recall through Koed memory tools.
_Avoid_: Recall-only integration, MCP-only integration

**MCP Server**:
The local integration process that exposes Koed memory tools to an AI client.
_Avoid_: AI client, backend, capture hook

**Diagnostic Memory Tool**:
A low-level memory tool exposed only for debugging or inspection.
_Avoid_: Supported recall path, normal memory tool

**Capture Hook**:
A client-side integration point that sends conversation activity to Koed for capture.
_Avoid_: MCP server, recall tool, backend poller

**Supported Capture Hook**:
The TypeScript Codex capture hook used as the supported automatic capture integration.
_Avoid_: Python capture hook, fallback hook, MCP capture endpoint

**Embedding Service**:
A local service that turns memory text into retrieval vectors.
_Avoid_: LLM provider, synthesis service, model provider

**Recall**:
Retrieving relevant memory evidence for an AI client.
_Avoid_: Synthesis, answer generation, summarization

**Evidence Bundle**:
Recalled memory evidence plus citation and retrieval metadata handed to an AI client for synthesis.
_Avoid_: Answer, summary, search result

**Memory Answer**:
The supported recall entry point that supplies evidence for AI-client answer synthesis.
_Avoid_: Backend answer generation, diagnostic search

**Synthesis**:
Producing natural-language answers or summaries from evidence.
_Avoid_: Recall, retrieval, embedding

**Answer Synthesis**:
Producing a response from recalled memory evidence.
_Avoid_: Recall, search, evidence retrieval

**LCM Placeholder**:
A deterministic backend-created source outline used until an LCM summary is submitted.
_Avoid_: LCM summary, generated summary, synthesis

**LCM Summary**:
A synthesized summary of memory source items or lower-level memory nodes.
_Avoid_: LCM placeholder, source outline, concatenation

**LCM Summary Service**:
Local background work that turns pending LCM placeholders into LCM summaries through the AI client.
_Avoid_: Agent tool, backend LLM worker, manual summarization

**Diagnostic Status**:
Non-blocking operational information used to inspect Koed Self-Hosted behavior.
_Avoid_: Health gate, setup requirement, authorization rule

**Pending LCM Staleness**:
A backend-visible diagnostic warning based on the age of the oldest pending LCM placeholder.
_Avoid_: Health failure, pending count, summarization error

**Memory**:
Durable knowledge captured from AI-client activity and later retrieved as evidence.
_Avoid_: Fact, note, document

**Personal Memory**:
Memory visible only to the owning user.
_Avoid_: Private memory, individual memory

**Team Memory**:
Memory visible to active members of the associated team.
_Avoid_: Shared memory, organization memory, tenant memory

**Memory Event**:
A captured source item from an AI-client session.
_Avoid_: Fact, extracted memory, log line

**Memory Node**:
A summarized retrievable unit derived from memory events or other memory nodes.
_Avoid_: Fact, document, chunk

**Retrieval Scope**:
The caller's choice of whether recall searches personal memory only or personal plus team memory.
_Avoid_: Visibility, search domain, access level

**Search Domain**:
The boundary that limits recall to one session, one project, or all visible memory.
_Avoid_: Retrieval scope, visibility, access level

**Capture Policy**:
A user-owned rule that decides whether AI-client activity may become memory and which visibility it receives.
_Avoid_: Permission, capture setting, retention rule

**Capture State**:
The part of a capture policy that decides whether automatic capture is enabled, disabled, or waiting for an AI-client ask flow.
_Avoid_: Visibility, capture target, pause

**Capture Target**:
The activity boundary a capture policy applies to.
_Avoid_: Capture state, visibility, search domain

**Capture Pause**:
A temporary capture-policy override that blocks automatic capture until a specified time.
_Avoid_: Capture state, disabled policy, deletion

## Relationships

- **Koed Self-Hosted** is operated by one **Operator**
- An **Operator** may use the **Operator Console** to create user API tokens and inspect system status
- One **Operator** may create one or more **Users**
- A **User** owns zero or more **API Tokens**
- An **API Token** allows an AI-client integration to access Koed
- In the current build, an **API Token** accesses only the owning **User's** **Personal Memory**
- In the current build, API-token requests for **Team Memory** are rejected
- In the current build, API-token capture with team visibility is rejected
- In the current build, one **API Token** may be shared by the **MCP Server** and **Supported Capture Hook**
- A **Team** has one or more **Users** as members
- A **Project** may have zero or more **Conversations**
- An **AI Client** produces one or more **Conversations**
- A **Supported AI Client Integration** requires one **Capture Hook**
- A **Supported AI Client Integration** requires recall through Koed memory tools
- An **AI Client** may use one **MCP Server** to call Koed memory tools
- A **Diagnostic Memory Tool** is hidden unless explicitly enabled
- An **AI Client** requires a **Capture Hook** for automatic conversation capture
- **Capture Hook** is the only supported automatic capture path in this build
- The **Supported Capture Hook** is the TypeScript Codex capture hook
- A **Capture Hook** may create a **Captured Session**
- An **Embedding Service** supports **Recall**
- **Recall** returns an **Evidence Bundle**
- **Memory Answer** is the normal entry point for **Recall**
- **Memory Answer** supplies an **Evidence Bundle** for **Answer Synthesis**
- An **AI Client** performs **Synthesis** from recalled evidence
- An **Evidence Bundle** is input to **Answer Synthesis**
- **Answer Synthesis** is a form of **Synthesis**
- An **LCM Summary** is a form of **Synthesis**
- The backend may create an **LCM Placeholder**
- The **MCP Server** may run an **LCM Summary Service** in the background
- The **LCM Summary Service** is enabled by default
- The **LCM Summary Service** has no operator opt-out in this build
- **LCM Summary Service** failure does not prevent capture or recall
- **LCM Summary Service** reports failures through **Diagnostic Status**
- **Pending LCM Staleness** is reported as **Diagnostic Status**
- An **AI Client** performs **Synthesis** to produce an **LCM Summary**
- An **LCM Summary** replaces an **LCM Placeholder**
- An **LCM Placeholder** may support **Recall** as degraded evidence until its **LCM Summary** exists
- A **Conversation** may have zero or more **Captured Sessions**
- A **User** owns one or more **Capture Policies**
- A **Capture Policy** applies to one **Capture Target**
- A **Capture Policy** has one **Capture State**
- A **Capture Policy** may have one **Capture Pause**
- Conversation **Capture Targets** override project **Capture Targets**
- Project **Capture Targets** override global **Capture Targets**
- A **Capture Pause** follows **Capture Target** precedence and may fall back to broader targets
- An active **Capture Pause** blocks automatic capture regardless of **Capture State**
- If no **Capture Policy** applies, automatic personal capture is enabled
- Default-on personal capture assumes the **Operator** controls the deployment and the **User** configured the AI-client integration
- In the current build, supported API-client **Capture Policies** are personal-only
- **Personal Memory** belongs to exactly one **User**
- **Team Memory** belongs to exactly one **Team**
- A **Retrieval Scope** may include **Personal Memory** only or both **Personal Memory** and **Team Memory**
- A **Search Domain** narrows recall within the selected **Retrieval Scope**
- **Memory** is composed from one or more **Memory Events**
- A **Memory Node** summarizes one or more **Memory Events** or **Memory Nodes**

## Example dialogue

> **Dev:** "Does **Koed Self-Hosted** include hosted onboarding or billing?"
> **Domain expert:** "No — **Koed Self-Hosted** is the self-managed distribution, not Koed Cloud."

> **Dev:** "Is the first local admin user the **Operator**?"
> **Domain expert:** "Not necessarily — the **Operator** owns the deployment responsibility, while local users are accounts inside it."

> **Dev:** "Should we call the local UI the console?"
> **Domain expert:** "Use **Operator Console** in domain language so it is not confused with terminal or AI-client consoles."

> **Dev:** "Should an API token belong to an account?"
> **Domain expert:** "Say **User** unless you mean the **Operator** responsible for the whole deployment."

> **Dev:** "Does the **Operator Console** generate an AI key?"
> **Domain expert:** "No — it creates an **API Token** for a **User** to access Koed."

> **Dev:** "Can an **API Token** read **Team Memory** in the current build?"
> **Domain expert:** "No — API-token access is limited to the owning **User's** **Personal Memory** until team-scoped token requirements are defined."

> **Dev:** "Should Codex use separate Koed tokens for **MCP Server** and **Supported Capture Hook**?"
> **Domain expert:** "No — use one **API Token** for both until token scopes have concrete semantics."

> **Dev:** "Should default **API Token** names mention Codex or MCP?"
> **Domain expert:** "No — use client-neutral names because the token grants Koed access for an AI-client integration."

> **Dev:** "If an API-token request asks for personal plus team **Retrieval Scope**, should Koed silently use personal only?"
> **Domain expert:** "No — reject team retrieval explicitly until team-scoped token requirements are defined."

> **Dev:** "If a **Capture Policy** resolves to team visibility for an API-token capture request, should Koed capture it as personal instead?"
> **Domain expert:** "No — reject team-visible API-token capture until team-scoped token requirements are defined."

> **Dev:** "Is a **Team** the same thing as the **Operator**?"
> **Domain expert:** "No — a **Team** is a sharing group inside the deployment, while the **Operator** runs the deployment."

> **Dev:** "Does every **Conversation** have a **Captured Session**?"
> **Domain expert:** "No — capture can be disabled or skipped, so a **Conversation** can exist without Koed storing a **Captured Session**."

> **Dev:** "Does the **MCP Server** automatically capture the whole **Conversation**?"
> **Domain expert:** "No — the **MCP Server** exposes memory tools; automatic conversation capture depends on client-specific hooks or transcript ingestion."

> **Dev:** "Can we rely on the **MCP Server** as the automatic **Capture Hook**?"
> **Domain expert:** "No — automatic capture requires a **Capture Hook** in the **AI Client** integration."

> **Dev:** "Are MCP session/event endpoints a supported automatic capture path?"
> **Domain expert:** "No — **Capture Hook** is the only supported automatic capture path in this build."

> **Dev:** "Is the Python capture hook the supported capture integration?"
> **Domain expert:** "No — the **Supported Capture Hook** is the TypeScript Codex capture hook."

> **Dev:** "Can an MCP-only integration be called a **Supported AI Client Integration**?"
> **Domain expert:** "No — it may be recall-only or experimental, but full support requires automatic capture and recall."

> **Dev:** "Should normal AI-client recall call low-level search and expand tools directly?"
> **Domain expert:** "No — those are **Diagnostic Memory Tools**; normal recall should use the supported answer path."

> **Dev:** "Does banning backend LLM calls mean the backend cannot run an **Embedding Service**?"
> **Domain expert:** "No — embeddings support **Recall**; **Synthesis** belongs to the connected **AI Client**."

> **Dev:** "If the backend returns evidence and instructions, did it perform **Answer Synthesis**?"
> **Domain expert:** "No — **Answer Synthesis** happens when the **AI Client** turns recalled evidence into a response."

> **Dev:** "Is the **Evidence Bundle** the answer?"
> **Domain expert:** "No — it is the cited material and metadata the **AI Client** uses for **Answer Synthesis**."

> **Dev:** "Does **Memory Answer** mean the backend generated the final answer?"
> **Domain expert:** "No — **Memory Answer** is the supported recall entry point; **Answer Synthesis** belongs to the **AI Client**."

> **Dev:** "Can the backend create the first text stored for an LCM node?"
> **Domain expert:** "Yes, but that text is an **LCM Placeholder** made from source material; the **LCM Summary** is synthesized by the **AI Client**."

> **Dev:** "Can **Recall** use an **LCM Placeholder** before the **LCM Summary** exists?"
> **Domain expert:** "Yes, but only as degraded evidence that must be identified as pending."

> **Dev:** "Should agents call a tool to run **LCM Summary** work manually?"
> **Domain expert:** "No — keep **LCM Summary Service** as local background work, not a normal agent tool."

> **Dev:** "Does the **Operator** need to enable **LCM Summary Service** manually?"
> **Domain expert:** "No — it is enabled by default with local locking and conservative concurrency."

> **Dev:** "Can the **Operator** disable **LCM Summary Service** with an environment variable?"
> **Domain expert:** "No — there is no opt-out in this build."

> **Dev:** "If local Codex cannot create **LCM Summaries**, should Koed stop serving recall?"
> **Domain expert:** "No — keep capture and recall working with pending **LCM Placeholders** as degraded evidence."

> **Dev:** "Should **LCM Summary Service** failures make Koed unhealthy?"
> **Domain expert:** "No — expose them as **Diagnostic Status**, not as a blocking health failure."

> **Dev:** "Should a high pending LCM count make Koed unhealthy?"
> **Domain expert:** "No — use **Pending LCM Staleness** as a non-blocking warning when the oldest pending placeholder is too old."

> **Dev:** "When the backend captures an important fact, does it create a **Memory**?"
> **Domain expert:** "Say **Memory Event** for captured source material; **Memory Nodes** make that material retrievable later."

> **Dev:** "If a **Capture Policy** says ask, does the backend prompt the **User**?"
> **Domain expert:** "No — ask means not automatically captured until an AI client implements an ask flow."

> **Dev:** "Is team visibility a **Capture State**?"
> **Domain expert:** "No — **Capture State** is enabled, disabled, or ask; visibility describes where captured memory would be stored."

> **Dev:** "Can a **Capture Target** be global, project, or thread?"
> **Domain expert:** "Use global, **Project**, or **Conversation** in domain language; code may still call conversation-level targets threads."

> **Dev:** "If global capture is enabled but a **Conversation** target is disabled, which wins?"
> **Domain expert:** "The **Conversation** target wins because more specific **Capture Targets** override broader ones."

> **Dev:** "Is a paused policy the same as a disabled **Capture State**?"
> **Domain expert:** "No — a **Capture Pause** is temporary and time-bound; disabled is a **Capture State**."

> **Dev:** "If **Capture State** is enabled but a **Capture Pause** is active, does capture happen?"
> **Domain expert:** "No — an active **Capture Pause** blocks capture until it expires."

> **Dev:** "What happens before a **User** creates any **Capture Policy**?"
> **Domain expert:** "Automatic personal capture is enabled by default."

> **Dev:** "Why is automatic capture enabled by default?"
> **Domain expert:** "Because **Koed Self-Hosted** assumes the **Operator** controls the deployment and the **User** chose to configure the AI-client integration."

> **Dev:** "Should supported API-client **Capture Policies** expose team visibility now?"
> **Domain expert:** "No — current API-client capture is personal-only until team-scoped token requirements are defined."

> **Dev:** "Does changing **Retrieval Scope** move a **Memory Event** from personal to team?"
> **Domain expert:** "No — **Retrieval Scope** controls recall, while **Personal Memory** and **Team Memory** describe who can see stored memory."

> **Dev:** "If recall uses personal plus team **Retrieval Scope** with a session **Search Domain**, does it search the whole team?"
> **Domain expert:** "No — it searches visible personal and team memory tied to that session only."

## Flagged ambiguities

- "fact" sounds like Koed extracts standalone truths; resolved: use **Memory Event** for captured source material and **Memory Node** for summarized retrieval units.
- "console" can mean terminal output or an AI-client console; resolved: use **Operator Console** for Koed's local management UI.
- "AI key" sounds like a model-provider credential; resolved: use **API Token** for Koed access by a user.
- Token names that mention Codex or MCP can overfit one integration path; resolved: use client-neutral **API Token** names by default.
- Team memory through API tokens is not firmed out; resolved: current **API Token** access is limited to **Personal Memory**.
- Silent fallback from team retrieval to personal retrieval can hide integration errors; resolved: reject API-token requests for **Team Memory** in this build.
- Silent fallback from team capture to personal capture can hide policy errors; resolved: reject team-visible API-token capture in this build.
- "ask" in a **Capture Policy** can sound like a backend prompt; resolved: it blocks automatic capture unless an AI client implements the consent step.
- "visibility" and "scope" are easy to conflate; resolved: **Personal Memory** and **Team Memory** describe stored memory visibility, while **Retrieval Scope** describes a recall request.
- "global" can sound like all stored memory; resolved: a global **Search Domain** still only searches memory visible under the selected **Retrieval Scope**.
- "workspace" and "thread" appear in code and client APIs; resolved: use **Project** and **Conversation** in domain language unless referring to a concrete API field.
- "MCP server" can be confused with the **AI Client**; resolved: the **AI Client** produces conversations, while the **MCP Server** exposes Koed tools to it.
- "capture hook" can be treated as optional MCP behavior; resolved: automatic conversation capture requires a **Capture Hook** distinct from the **MCP Server**.
- MCP capture plumbing can be confused with supported automatic capture; resolved: **Capture Hook** is the only supported automatic capture path in this build.
- "supported integration" can be overused for recall-only prototypes; resolved: a **Supported AI Client Integration** includes both automatic capture and recall.
- "AI work" can over-broaden the server-side LLM decision; resolved: backend **Recall** may use embeddings and ranking, while **Synthesis** is performed by the **AI Client**.
- "summary" can mean either backend source-outline text or synthesized LCM output; resolved: use **LCM Placeholder** for deterministic backend text and **LCM Summary** for synthesized output.
- Pending LCM evidence can look complete; resolved: an **LCM Placeholder** may support **Recall** only as degraded evidence until its **LCM Summary** exists.
- LCM summarization can look like a normal agent task; resolved: **LCM Summary Service** is local background work, not an agent-facing tool.
