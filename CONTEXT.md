# Koed

Koed is the product context for running memory capture, recall, and inspection
on infrastructure controlled by the operator.

## Language

**AI Client**:
An external AI tool that produces conversations and may call Koed for capture or recall.
_Avoid_: MCP server, model provider, assistant

**Answer Synthesis**:
Producing a response from recalled memory evidence.
_Avoid_: Recall, search, evidence retrieval

**API Token**:
A user-owned credential used by an AI-client integration to access Koed.
_Avoid_: AI key, provider key, password

**Capture Hook**:
A client-side integration point that sends conversation activity to Koed for capture.
_Avoid_: MCP server, recall tool, backend poller

**Capture Pause**:
A temporary capture-policy override that blocks automatic capture until a specified time.
_Avoid_: Capture state, disabled policy, deletion

**Capture Policy**:
A user-owned rule that decides whether AI-client activity may become memory.
_Avoid_: Permission, capture setting, retention rule

**Capture State**:
The part of a capture policy that decides whether automatic capture is enabled, disabled, or waiting for an AI-client ask flow.
_Avoid_: Visibility, capture target, pause

**Capture Target**:
The activity boundary a capture policy applies to.
_Avoid_: Capture state, visibility, search domain

**Captured Session**:
Koed's record of memory capture for a conversation.
_Avoid_: Conversation, thread, transcript

**Conversation**:
An AI-client interaction thread whose activity may be captured.
_Avoid_: Thread, chat, transcript

**Diagnostic Memory Tool**:
A low-level memory tool exposed only for debugging or inspection.
_Avoid_: Supported recall path, normal memory tool

**Diagnostic Status**:
Non-blocking operational information used to inspect Koed behavior.
_Avoid_: Health gate, setup requirement, authorization rule

**Embedding Service**:
A local service that turns memory text into retrieval vectors.
_Avoid_: LLM provider, synthesis service, model provider

**Evidence Bundle**:
Recalled memory evidence plus citation and retrieval metadata handed to an AI client for synthesis.
_Avoid_: Answer, summary, search result

**Koed**:
The AGPL-licensed Koed distribution for operator-managed memory
infrastructure.
_Avoid_: Koed Cloud, hosted Koed, open-source Koed as a separate product name

**LCM Placeholder**:
A deterministic backend-created source outline used until an LCM summary is submitted.
_Avoid_: LCM summary, generated summary, synthesis

**LCM Leaf**:
The first-level Memory Node that summarizes one or more Memory Events.
_Avoid_: Memory event, raw capture, final answer

**LCM Rollup**:
The second-level Memory Node that summarizes one or more LCM leaves.
_Avoid_: Memory event, raw capture, backend answer

**LCM Summary**:
A synthesized summary of memory source items or lower-level memory nodes.
_Avoid_: LCM placeholder, source outline, concatenation

**LCM Summary Service**:
Local background work that turns pending LCM placeholders into LCM summaries through the AI client.
_Avoid_: Agent tool, backend LLM worker, manual summarization

**Local Operator Scripts**:
Trusted commands run from the deployment checkout, such as API Token bootstrap.
_Avoid_: Console, dashboard, admin app

**Local-Edge Client Credential**:
A revocable credential scoped to one enrolled upstream backend and explicit
operation families, used by a local integration such as the MCP Server to ask
the local edge to perform Team operations. It is distinct from a Personal API
Token and from the upstream device credential used against the Team Backend.
_Avoid_: API Token, upstream credential, browser session

**MCP Server**:
The local integration process that exposes Koed memory tools to an AI client.
_Avoid_: AI client, backend, capture hook

**Memory**:
Durable knowledge captured from AI-client activity and later retrieved as evidence.
_Avoid_: Fact, note, document

**Memory Answer**:
The supported recall entry point that supplies evidence for AI-client answer synthesis.
_Avoid_: Backend answer generation, diagnostic search

**Memory Event**:
A captured source item from an AI-client session.
_Avoid_: Fact, extracted memory, log line

**Memory Node**:
A summarized retrievable unit derived from memory events or other memory nodes.
_Avoid_: Fact, document, chunk

**Operator**:
The person or organization responsible for running a Koed deployment.
_Avoid_: Customer, tenant, account

**Pending LCM Staleness**:
A backend-visible diagnostic warning based on the age of the oldest pending LCM placeholder.
_Avoid_: Health failure, pending count, summarization error

**Personal Memory**:
Memory visible only to the owning user.
_Avoid_: Private memory, individual memory

**Project**:
A local AI-client or code context such as a repository, working directory,
filepath, ref, branch, or cwd.
_Avoid_: Workspace, stable shared memory ID

**Projection**:
The transformation from captured source activity into Koed semantic memory
structures used for recall, summaries, graph views, and inspection.
_Avoid_: Capture, synthesis, raw ingestion

**Recall**:
Retrieving relevant memory evidence for an AI client.
_Avoid_: Synthesis, answer generation, summarization

**Retrieval Scope**:
The caller's choice of which visible memory classes recall may search.
_Avoid_: Visibility, search domain, access level

**Search Domain**:
The boundary that limits recall to one session, the current Project or resolved
Workspace context, or all visible memory.
_Avoid_: Retrieval scope, visibility, access level

**Access Suspension**:
A lifecycle state that restricts access or ingestion without deleting retained
Memory, Team records, Workspace records, or Share Grants.
_Avoid_: Deletion, archive, share revocation

**Content Inventory**:
A deduplicated index of external content known to a Koed deployment.
_Avoid_: Upload folder, memory store, document list

**Content Object**:
An external source item such as a file, URL, repository reference, meeting note,
or other uploaded material that can be ingested into memory.
_Avoid_: Memory Event, Captured Session, attachment

**Cross-Identity Sync**:
A policy-controlled sync relationship that keeps one logical memory lifespan
available across identities or deployments, such as a personal Koed identity
and a Team-side personal identity.
_Avoid_: Fork, import, copy, ownership transfer

**Fork/Import**:
An explicit operation that creates a separate memory lifespan from an existing
memory source.
_Avoid_: Share, Cross-Identity Sync, migration

**Knowledge Collection**:
A grantable set of Content Objects prepared for future Memory Inbox recall.
_Avoid_: Workspace, Project, Team, folder

**Share Grant**:
An access record that allows Team recall of a user-owned memory source within a
Workspace.
_Avoid_: Ownership transfer, copy, export

**Supported AI Client Integration**:
An AI-client integration that supports both automatic capture through a capture hook and recall through Koed memory tools.
_Avoid_: Recall-only integration, MCP-only integration

**Supported Capture Hook**:
The TypeScript Codex capture hook used as the supported automatic capture integration.
_Avoid_: Python capture hook, fallback hook, MCP capture endpoint

**Synthesis**:
Producing natural-language answers or summaries from evidence.
_Avoid_: Recall, retrieval, embedding

**Team**:
A collaboration boundary for shared memory access.
_Avoid_: Operator, customer, account

**Team Membership**:
A User's participation state and role within a Team.
_Avoid_: Workspace access, API token permission

**Team Retention Policy**:
A Team-level rule that may decide how Team-shared Memory behaves after an
owning User removes it from Personal Memory.
_Avoid_: Personal deletion, share revocation, legal hold

**Team-shared Memory**:
User-owned Memory made recallable to Team members through an active Share Grant.
_Avoid_: Team-owned memory, public memory, copied memory

**Memory Inbox**:
A future ingestion surface for external Content Objects and Knowledge
Collections.
_Avoid_: Conversation capture, file browser, cloud drive

**Offload**:
Moving storage or processing work to a hosted Koed service while preserving the
memory's policy and provenance boundary.
_Avoid_: Share, Fork/Import, backup

**Soft Delete**:
A retained lifecycle state that hides a resource from normal active flows while
preserving it for audit, restore, retention, or authorized archived search.
_Avoid_: Hard delete, access suspension, share revocation

**User**:
A human account authenticated inside a Koed deployment.
_Avoid_: Account, customer, operator

**Workspace**:
A stable shared ID for memories within a Team.
_Avoid_: Project, repository, filepath, branch, cwd

**Workspace Access**:
A User's ability to recall, share, or manage Team-shared Memory for a Workspace.
_Avoid_: Project metadata, Team membership, API token permission

**Workspace Archive**:
The Soft Delete state for a Workspace.
_Avoid_: Share revocation, Access Suspension, Project removal

## Relationships

- **Koed** is operated by one **Operator**
- An **Operator** may use **Local Operator Scripts** to create user API tokens
- One **Operator** may create one or more **Users**
- A **User** owns zero or more **API Tokens**
- An **API Token** allows an AI-client integration to access memory visible to
  the owning **User**
- An **API Token** does not own **Team** or **Workspace Access** directly
- A **User** may have **Team Membership** in zero or more **Teams**
- A **Team** may have one or more **Workspaces**
- A **Workspace** has one stable shared ID for memories
- A **User** may have **Workspace Access** through a **Team**
- A **Project** may resolve to one **Workspace**
- **Cross-Identity Sync** keeps one logical memory lifespan available across
  identities or deployments without creating a fork
- **Fork/Import** creates a separate memory lifespan only when explicitly
  requested
- **Offload** changes where storage or processing happens; it does not by itself
  create a **Share Grant**
- **Access Suspension** may restrict recall, sharing, ingestion, or management
  without deleting retained **Memory**
- A **Workspace Archive** hides a **Workspace** from normal active flows without
  deleting retained **Team-shared Memory**
- In the current build, one **API Token** may be used by the **MCP Server** and **Supported Capture Hook**
- A **Project** may provide local context for zero or more **Conversations**
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
- **Team-shared Memory** remains owned by the originating **User**
- A **Share Grant** makes one user-owned memory source recallable to one
  **Team** in one **Workspace**; the first implemented source is a
  **Captured Session**
- A **Share Grant** may allow summary-only recall or source-detail expansion
- Removing a **User** from a **Team** or **Workspace** removes future access but
  does not delete retained **Team-shared Memory**
- A **Share Grant** revocation, **Workspace Archive**, **Access Suspension**,
  **Soft Delete**, and hard purge are separate lifecycle operations
- **Memory** is composed from one or more **Memory Events**
- A **Memory Inbox** may ingest **Content Objects** into **Knowledge
  Collections**
- A **Knowledge Collection** may be granted to one or more authorized groups
  without duplicating the underlying **Content Objects**
- **Projection** transforms captured source activity into Koed semantic memory structures such as **Memory Events**
- A **Memory Node** summarizes one or more **Memory Events** or **Memory Nodes**
- An **LCM Leaf** is a **Memory Node** summarized from one or more **Memory Events**
- An **LCM Rollup** is a **Memory Node** summarized from one or more **LCM Leaves**
- An **LCM Summary** may complete either an **LCM Leaf** or an **LCM Rollup**
- A **Retrieval Scope** may include **Personal Memory** and **Team-shared Memory**
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

> **Dev:** "Can we use the local repo path as the Team memory boundary?"
> **Domain expert:** "No — a **Project** is local context. **Workspace** is the stable shared ID for memories."

> **Dev:** "Does sharing a session move it into Team ownership?"
> **Domain expert:** "No — **Team-shared Memory** remains user-owned and is recallable through a **Share Grant**."

> **Dev:** "If I share personal memory into my Team identity, is that a fork?"
> **Domain expert:** "No — use **Cross-Identity Sync** when the same logical memory lifespan should continue across identities."

> **Dev:** "If a Team stops paying, do we delete its memories?"
> **Domain expert:** "No — use **Access Suspension** or ingestion gating. Retained **Memory** is not deleted."

## Flagged Ambiguities

- "fact" sounds like Koed extracts standalone truths; resolved: use **Memory Event** for captured source material and **Memory Node** for summarized retrieval units.
- "console" can mean terminal output or an AI-client console; avoid it for Koed operator flows.
- "AI key" sounds like a model-provider credential; resolved: use **API Token** for Koed access by a user.
- "ask" in a **Capture Policy** can sound like a backend prompt; resolved: it blocks automatic capture unless an AI client implements the consent step.
- "visibility" and "scope" are easy to conflate; resolved: **Personal Memory** describes stored memory visibility, while **Retrieval Scope** describes a recall request.
- "global" can sound like all stored memory; resolved: a global **Search Domain** still only searches memory visible under the selected **Retrieval Scope**.
- "project" and "workspace" are easy to conflate; resolved: **Project** is
  local AI-client/code context, while **Workspace** is the stable shared ID for
  memories.
- "team memory" can sound like the Team owns the memory; resolved:
  **Team-shared Memory** remains owned by the originating **User** and is
  accessed through a **Share Grant**.
- "sharing", "syncing", and "importing" can sound interchangeable; resolved:
  **Share Grant** changes recall authorization, **Cross-Identity Sync** keeps one
  logical memory lifespan available across identities, and **Fork/Import**
  creates a separate memory lifespan.
- "Memory Inbox" can sound like a second memory ownership model; resolved:
  **Memory Inbox** adds external **Content Objects** and **Knowledge
  Collections**, while access still flows through grants and policy.
- "deleted" can mean many things; resolved: use **Soft Delete** or
  **Workspace Archive** for retained resources, **Access Suspension** for
  temporary or policy-driven access restrictions, and hard purge only for
  irreversible deletion.
