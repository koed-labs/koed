# Koed Self-Hosted

Koed Self-Hosted is the product context for running Koed memory capture, recall, and inspection on infrastructure controlled by the operator.

## Language

**Koed Self-Hosted**:
The source-available Koed distribution for self-managed memory infrastructure.
_Avoid_: Koed Cloud, hosted Koed, open-source Koed

**Operator**:
The person or organization responsible for running a Koed Self-Hosted deployment.
_Avoid_: Customer, tenant, account

**Local Operator Scripts**:
Trusted commands run from the deployment checkout, such as API Token bootstrap.
_Avoid_: Console, dashboard, admin app

**User**:
A human account authenticated inside a Koed Self-Hosted deployment.
_Avoid_: Account, customer, operator

**API Token**:
A user-owned credential used by an AI-client integration to access Koed.
_Avoid_: AI key, provider key, password

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

**Memory Event**:
A captured source item from an AI-client session.
_Avoid_: Fact, extracted memory, log line

**Memory Node**:
A summarized retrievable unit derived from memory events or other memory nodes.
_Avoid_: Fact, document, chunk

**Retrieval Scope**:
The caller's choice of whether recall searches personal memory.
_Avoid_: Visibility, search domain, access level

**Search Domain**:
The boundary that limits recall to one session, one project, or all visible memory.
_Avoid_: Retrieval scope, visibility, access level

**Capture Policy**:
A user-owned rule that decides whether AI-client activity may become memory.
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
- An **Operator** may use **Local Operator Scripts** to create user API tokens
- One **Operator** may create one or more **Users**
- A **User** owns zero or more **API Tokens**
- An **API Token** allows an AI-client integration to access the owning **User's** **Personal Memory**
- In the current build, one **API Token** may be used by the **MCP Server** and **Supported Capture Hook**
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
- **Personal Memory** belongs to exactly one **User**
- **Memory** is composed from one or more **Memory Events**
- A **Memory Node** summarizes one or more **Memory Events** or **Memory Nodes**
- A **Retrieval Scope** currently includes **Personal Memory**
- A **Search Domain** narrows recall within the selected **Retrieval Scope**
- A **User** owns one or more **Capture Policies**
- A **Capture Policy** applies to one **Capture Target**
- A **Capture Policy** has one **Capture State**
- A **Capture Policy** may have one **Capture Pause**
- Conversation **Capture Targets** override project **Capture Targets**
- Project **Capture Targets** override global **Capture Targets**
- A **Capture Pause** follows **Capture Target** precedence and may fall back to broader targets
- An active **Capture Pause** blocks automatic capture regardless of **Capture State**
- If no **Capture Policy** applies, automatic personal capture is enabled

## Example Dialogue

> **Dev:** "Can an **API Token** read another user's **Personal Memory**?"
> **Domain expert:** "No — an **API Token** accesses only the owning **User's** **Personal Memory**."

> **Dev:** "Does changing **Retrieval Scope** move a **Memory Event**?"
> **Domain expert:** "No — **Retrieval Scope** controls recall, while **Personal Memory** describes stored memory visibility."

> **Dev:** "Does **Memory Answer** mean the backend generated the final answer?"
> **Domain expert:** "No — **Memory Answer** is the supported recall entry point; **Answer Synthesis** belongs to the **AI Client**."

## Flagged Ambiguities

- "fact" sounds like Koed extracts standalone truths; resolved: use **Memory Event** for captured source material and **Memory Node** for summarized retrieval units.
- "console" can mean terminal output or an AI-client console; avoid it for Koed operator flows.
- "AI key" sounds like a model-provider credential; resolved: use **API Token** for Koed access by a user.
- "ask" in a **Capture Policy** can sound like a backend prompt; resolved: it blocks automatic capture unless an AI client implements the consent step.
- "visibility" and "scope" are easy to conflate; resolved: **Personal Memory** describes stored memory visibility, while **Retrieval Scope** describes a recall request.
- "global" can sound like all stored memory; resolved: a global **Search Domain** still only searches memory visible under the selected **Retrieval Scope**.
