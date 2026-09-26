# Enterprise Software Intelligence Platform — Complete Backend Requirements

## 1. PURPOSE

The backend shall provide an enterprise-grade software intelligence platform that can ingest a software project's source code and documentation, understand the project, maintain project knowledge, and answer user questions grounded in that project.

The system shall support:

- Engineering teams
- Product/business teams
- Support teams
- Operations teams
- Enterprise administrators
- Multiple organizations
- Multiple projects
- Multiple users
- Multiple roles
- Multiple source updates
- Persistent conversations
- Project-aware conversational context
- Code and documentation understanding
- Database query generation and execution in a **later slice** (not current; see below)

The backend must be designed as a **multi-tenant SaaS platform** with strong isolation, authorization, auditability, reliability, and scalability.

### Current product slice — out of scope

The following are **not** acceptance criteria for the current product slice. Where later
sections still describe them, they are retained as future requirements only:

- Live query generation or execution against a **customer application database**
  (§§71–82, 121–126)
- Document or code embeddings, vector search, or a reranker (§§22, 57)
- Image upload / image-as-source processing (§10)

### Target application (design baseline)

The primary ingested target application class is a **Node.js application using MongoDB**.

Scale the backend must be designed for (not a small demo):

- On the order of **~2 million lines of code**
- Source files larger than the active code indexer's supported per-file limit may be accepted,
  but they must be excluded from code intelligence with a visible reason
- Any project with excluded source files must report **partial** knowledge; it must not claim
  complete code understanding
- Documentation alongside source (Markdown preferred)
- Dependency trees that commonly include `node_modules` (must be excluded from ingest)

Design indexing, retrieval, and job processing must assume this scale. Do not optimize only
for tiny sample repos. Do not introduce embeddings or vector search in this slice.

---

# 2. CORE BACKEND PRINCIPLE

The system should conceptually operate as:

```text
Project Source
     │
     ├── Source Code
     ├── Documentation
     ├── Repository
     └── Future Updates
            │
            ▼
      Ingestion
            │
            ▼
      Source Analysis
            │
            ▼
   Project Understanding
            │
            ▼
     Knowledge Creation
            │
            ▼
       Project Knowledge
            │
            ├───────────────┐
            ▼               ▼
        Chat/QA          Search
            │
            ▼
      Question Understanding
            │
       ┌────┴────┐
       │         │
   Clarify    Sufficient
       │         │
       └────┬────┘
            ▼
     Knowledge Retrieval
            │
            ▼
       Reasoning / Analysis
            │
      ┌─────┴────────┐
      │              │
    Normal        DB Query
    Answer        Required
      │              │
      │         Query Generation
      │              │
      │         Validation
      │              │
      │         Authorization
      │              │
      │         Execution
      │              │
      └──────┬───────┘
             ▼
          Response
             │
             ▼
          Evidence
```

The **DB Query** branch is **not** part of the current product slice. See §1 and §71.

---

# 3. MULTI-TENANCY

The platform must support multiple organizations.

Each organization must have isolated:

- Users
- Projects
- Source code
- Documentation
- Knowledge
- Conversations
- Query history
- Usage
- Configuration
- Audit information

A user belonging to one organization must never be able to access another organization's information unless explicitly authorized.

Tenant isolation must apply to every backend operation.

---

# 4. ORGANIZATION

An organization represents a SaaS customer.

An organization should contain:

- Organization information
- Users
- Roles
- Projects
- Access policies
- Usage information
- Configuration
- Audit history

The backend must support organization-level administration.

---

# 5. USER MANAGEMENT

The backend must support:

- User creation
- User authentication
- User activation
- User deactivation
- Password management
- Password reset
- Role assignment
- Project access
- User removal
- User status

Administrators must be able to create users for their organization.

Administrators must be able to reset passwords for permitted users.

---

# 6. ROLE-BASED ACCESS CONTROL

The backend must provide role-based authorization.

Permissions should be granular enough to control operations such as:

- View organization
- Manage users
- Manage roles
- Create projects
- View projects
- Update projects
- Delete projects
- Upload source
- Connect repositories
- Trigger knowledge updates
- View knowledge
- Ask questions
- View conversations
- Archive conversations
- Search project knowledge
- Generate database queries (later slice; not current)
- Execute database queries (later slice; not current)
- View query results (later slice; not current)
- Manage project settings
- View audit logs
- View usage

The backend must enforce permissions regardless of what the UI displays.

Never rely on frontend authorization alone.

---

# 7. PROJECT MODEL

A project represents one software system/application.

A project should contain:

- Project identity
- Organization
- Description
- Source configuration
- Repository configuration
- Branch information
- Source versions
- Documentation
- Knowledge status
- Knowledge versions
- Conversations
- Project configuration
- Access permissions
- Processing history
- Audit information

---

# 8. PROJECT ACCESS

Project access must be independently controllable.

A user may have access to:

- All organization projects
- Selected projects
- No projects

Project-level permissions must be evaluated on every relevant operation.

---

# 9. PROJECT CREATION

The backend must support project creation through:

1. Source upload
2. Repository connection

The project must not become partially usable without clearly representing its current state.

Possible project states include:

- Creating
- Awaiting source
- Connecting repository
- Source received
- Processing
- Knowledge ready
- Updating
- Failed
- Partially available
- Archived

---

# 10. SOURCE INGESTION

The backend must support source ingestion from:

- Multiple file uploads
- Folder uploads
- ZIP uploads
- GitHub repositories
- GitLab repositories

The system must support adding more source material to an existing project later.

### Upload-time exclusion (`node_modules` and similar)

Wherever the upload format exposes file paths (ZIP entries, multipart file lists, folder uploads, repository trees), the backend **must skip** irrelevant paths **during upload / extract** so they are never stored as project source. At minimum exclude:

- `node_modules/`
- Other deterministic ignore patterns (e.g. `.git/`, `dist/`, `build/`, `coverage/`) as configured

Skipped paths must be recorded in processing information so users can see what was excluded.

If the upload format **cannot** be path-filtered (rare/opaque formats), the backend must reject the upload with a clear error asking the user to remove `node_modules` (and similar) and re-upload.

Image upload / image-as-source processing is **out of scope** for the current product slice unless explicitly re-enabled later.

---

# 11. MULTIPLE SOURCE UPDATES

A project can receive source multiple times.

For example:

```text
Initial upload
     ↓
Additional documentation
     ↓
New source version
     ↓
Repository update
     ↓
Another documentation upload
```

Each update must be tracked.

The backend must not treat every upload as a completely new project.

---

# 12. SOURCE VERSIONING

Track source updates as identifiable versions or processing events.

Each source update should have:

- Project
- Source origin
- Timestamp
- Initiating user
- Files affected
- Processing status
- Result
- Errors
- Knowledge update status

The backend must be able to determine which knowledge state corresponds to which source state.

---

# 13. SOURCE DEDUPLICATION

When the same source is uploaded repeatedly, the backend should avoid unnecessary reprocessing where it can reliably determine that content has not changed.

This must not compromise correctness.

---

# 14. SOURCE EXCLUSION

The backend must support excluding irrelevant source content.

For example, unnecessary generated/dependency directories may be excluded.

The exclusion behavior must be deterministic and visible in processing information.

Users should be able to understand what was excluded.

---

# 15. FILE VALIDATION

Before processing uploaded content, validate:

- File integrity
- Supported format
- Size constraints
- Archive integrity
- Path safety
- Duplicate content
- Unsupported content

Invalid content should produce understandable errors.

---

# 16. SECURE FILE HANDLING

Uploaded source code and documentation must be treated as sensitive enterprise information.

The backend must prevent:

- Unauthorized access
- Path traversal
- Arbitrary file access
- Cross-project access
- Cross-tenant access
- Unauthorized downloads
- Unauthorized processing

---

# 17. REPOSITORY CONNECTION

The backend must support connecting repositories through GitHub and GitLab.

The system must:

1. Accept repository information.
2. Attempt connection.
3. Authenticate when necessary.
4. Validate access.
5. Retrieve available branches.
6. Allow branch selection.
7. Retrieve project content.
8. Start processing.

---

# 18. REPOSITORY AUTHENTICATION

If repository authentication is required, the backend must clearly communicate the authentication state to the UI.

Possible states:

- Authentication required
- Authentication in progress
- Authentication successful
- Authentication failed
- Access denied
- Repository unavailable

The backend must not expose sensitive credentials in logs, responses, errors, or UI payloads.

---

# 19. REPOSITORY CREDENTIALS

Repository credentials must be securely handled.

The backend must:

- Minimize credential exposure
- Avoid returning secrets
- Avoid logging secrets
- Support credential validation
- Support credential replacement/revocation
- Respect the user's authorization scope

The backend should request only the permissions necessary for supported operations.

---

# 20. BRANCH MANAGEMENT

After repository connection, retrieve available branches.

The backend must support:

- Branch listing
- Branch selection
- Branch validation
- Source retrieval from selected branch
- Future branch changes where permitted

The selected branch must be associated with the project's source configuration.

---

# 21. REPOSITORY UPDATES

The system should support future repository updates.

When a project source changes, the backend should be able to determine:

- Added files
- Modified files
- Removed files
- Documentation changes
- Potentially affected knowledge

The backend should update project knowledge accordingly.

---

# 22. DOCUMENT INGESTION

Documentation must be treated as a first-class project source.

The current product slice supports Markdown, MDX, and plain-text documentation.

Documentation must be associated with the project and remain available through authorized,
project-scoped path listing, keyword/full-text search, and bounded section/line reads.

The current product slice does not require document embeddings, vector search, reranking, or
precomputed document understanding. The backend must retrieve document text on demand and must
not send every project document to the language model.

---

# 23. SOURCE ANALYSIS

The backend must analyze supported project source sufficiently to understand:

- Project structure
- Files
- Components
- Functions
- Classes
- APIs
- Dependencies
- Relationships
- Workflows
- Business functionality
- Data-related concepts
- Integrations
- Configuration where relevant

Documentation may supplement this analysis through on-demand search and bounded reads. It is not
part of the structural code graph.

The selected code indexer may impose a per-file byte limit. Files beyond that limit must be
recorded as excluded, and the resulting knowledge health must be partial.

---

# 24. CODE UNDERSTANDING

The system must be capable of answering questions about source code.

Examples:

- What does this function do?
- Where is authentication implemented?
- How does checkout work?
- Which component calls this function?
- Where is this API handled?
- What happens when payment fails?
- Which code handles cancellation?
- What dependencies does this component have?

Answers must be grounded in the project's available source and documentation.

---

# 25. FUNCTIONAL UNDERSTANDING

The system must understand functionality beyond individual code files.

For example:

> How does a customer place an order?

The system should be able to connect relevant:

- APIs
- Functions
- Components
- Services
- Data
- Documentation
- Business rules

into an understandable workflow.

---

# 26. PROJECT KNOWLEDGE

Each project must maintain a persistent knowledge state derived from its available sources.

Knowledge must be associated with the project.

The backend should support:

- Creating knowledge
- Updating knowledge
- Rebuilding knowledge
- Tracking knowledge versions
- Detecting stale knowledge
- Handling partial knowledge
- Reporting knowledge status

---

# 27. KNOWLEDGE UPDATE

When new source or documentation is added:

```text
Existing Knowledge
        +
New Source
        ↓
Impact Analysis
        ↓
Knowledge Update
```

The backend should update affected knowledge instead of unnecessarily rebuilding everything when correctness can be maintained.

---

# 28. KNOWLEDGE CONSISTENCY

The backend must prevent the system from presenting obsolete project information as current when the system knows that the relevant source has changed.

Where knowledge may be stale, expose that state.

---

# 29. KNOWLEDGE VERSIONING

Knowledge updates should be traceable.

The backend should be able to identify:

- Knowledge version
- Source version
- Creation time
- Update time
- Processing status
- Triggering source changes

---

# 30. KNOWLEDGE CREATION WORKFLOW

Knowledge creation must be represented as an observable workflow.

Example:

```text
Source received
      ↓
Source validated
      ↓
Files identified
      ↓
Documentation identified
      ↓
Project structure analyzed
      ↓
Code relationships analyzed
      ↓
Functionality identified
      ↓
Knowledge updated
      ↓
Knowledge validated
      ↓
Ready
```

The exact stages may differ depending on the implementation, but the backend must provide meaningful progress information.

---

# 31. PROCESSING JOBS

Long-running operations must be represented as trackable jobs.

Examples:

- Source upload
- Repository retrieval
- Source processing
- Knowledge creation
- Knowledge update
- Repository synchronization
- Query execution where applicable (later slice; not current)

Each job must have a unique identity and lifecycle.

---

# 32. JOB STATES

Support states such as:

- Pending
- Running
- Completed
- Completed with warnings
- Failed
- Cancelled
- Retrying

The UI must be able to query the current state.

---

# 33. JOB PROGRESS

Where meaningful progress can be measured, expose:

- Current stage
- Completed stages
- Current progress
- Items processed
- Warnings
- Errors
- Start time
- Completion time

Do not fabricate progress.

If exact percentage is unavailable, expose stage-based progress instead.

---

# 34. JOB LOGS

Processing operations must generate understandable activity events.

Example:

```text
Source uploaded
Files identified
Documentation analyzed
Project structure analyzed
Checkout workflow identified
Knowledge updated
```

Logs should be designed for user understanding, not only developer debugging.

---

# 35. PROCESSING HISTORY

The backend must retain processing history.

Users with permission should be able to inspect:

- Previous processing operations
- Start/end time
- Trigger
- Result
- Warnings
- Errors
- Retry information

---

# 36. FAILED PROCESSING

A failed processing operation must not disappear.

The backend must preserve its status.

The user must be able to retrieve the failure later.

---

# 37. RETRY

Recoverable processing operations must support retry.

Where possible:

> Retry only failed processing

rather than repeating successful processing.

The backend must prevent duplicate processing caused by repeated user actions.

---

# 38. PARTIAL PROCESSING

If some files fail while the rest succeed, the backend should support a partial-success state.

Example:

> 4,812 files processed successfully.

> 9 files failed.

The available knowledge should clearly indicate whether it is complete or partial.

---

# 39. ERROR MODEL

Backend errors must contain enough structured information for the UI to provide a useful message.

Errors should distinguish:

- User error
- Authorization error
- Source error
- Repository error
- Processing error
- Knowledge error
- Query error
- System error
- Temporary failure

Do not require the UI to parse raw error strings.

---

# 40. CHAT CONVERSATIONS

Each project must support persistent conversations.

A conversation belongs to:

- Organization
- Project
- User

subject to the applicable access model.

---

# 41. CONVERSATION PERSISTENCE

Store conversation history so users can:

- Return later
- Continue
- Search
- Rename
- Archive
- Restore
- Delete where permitted

---

# 42. CONVERSATION CONTEXT

The backend must maintain sufficient conversational context to support follow-up questions.

Example:

```text
User:
How does checkout work?

Assistant:
...

User:
What happens when payment fails?

Assistant:
...
```

The second question must be understood in the context of the first.

---

# 43. CONVERSATION CONTEXT MANAGEMENT

The backend must manage conversations as they grow.

Before every language-model call, the backend must use the tokenizer that matches the active model
artifact to calculate the assembled input size. The backend must reserve capacity for the requested
output before sending the request.

The effective input and output limits must come from configuration backed by a completed benchmark;
the model vendor's advertised maximum must not be treated as an operational limit without testing.

When context approaches the validated input capacity, the backend must apply this order:

1. Preserve system and grounding rules, the current question, clarification answers, and pinned
   user facts.
2. Replace older conversation turns with a persisted summary created before the hard limit.
3. Remove lower-ranked tool evidence and oversized source/document excerpts.
4. Ask the user to narrow the question or abstain if the minimum grounded prompt still does not fit.

The system must not silently lose critical conversational information or evidence.

If the matching tokenizer is unavailable or does not match the active model artifact, the backend
must fail closed with a structured, retryable context-accounting error. It must not send the prompt
using a fabricated or knowingly unreliable token estimate.

---

# 44. CONVERSATION CONTEXT LIMIT

For each language-model call, the backend must record and expose, where reliable:

- Validated input limit
- Measured input token count
- Reserved output token capacity
- Context percentage consumed
- Whether conversation or evidence content was summarized, removed, or otherwise reduced
- Provider-reported input/output usage after completion

These values must describe the effective model configuration used for that call. The UI must never
be forced to guess context consumption. If the values cannot be calculated reliably, the model call
must not start.

---

# 45. CHAT MESSAGE MODEL

Messages should retain:

- Conversation
- User/assistant role
- Content
- Timestamp
- Processing status
- Related sources
- Clarification state where applicable
- Metrics where available
- Errors where applicable

---

# 46. MESSAGE EDITING

Users must be able to edit their previous user messages if permitted.

The backend must support resubmitting an edited message within the conversation.

The system must maintain sufficient history to understand what changed.

---

# 47. EDITED MESSAGES

The backend should support a clear model for edited messages.

If editing a previous message changes subsequent conversation context, the backend must prevent ambiguity.

**Chosen behavior for this slice: replace the downstream conversation.**

The conversation stays a **single thread**. The edited user message is updated in place.
Messages after that point are removed from the active thread (soft-delete) and a new answer
is generated from the edited content. This must be visible to the user: later answers from
the old wording are gone.

Do not create a conversation-branch switcher in this slice.

---

# 48. CONVERSATION ARCHIVING

Support:

- Archive
- Restore
- Delete where permitted

Archive must not destroy conversation history.

Archived conversations should remain retrievable.

---

# 49. CONVERSATION SEARCH

The backend must support searching a user's accessible project conversations.

Search should consider:

- Conversation title
- User messages
- Assistant messages
- Relevant metadata

Search must respect tenant and project authorization.

---

# 50. CONVERSATION TITLES

The backend should generate useful conversation titles where appropriate.

Examples:

- Checkout flow
- Authentication implementation
- Payment failure investigation

Titles should be editable by the user.

---

# 51. QUESTION UNDERSTANDING

For every user question, the backend should first determine:

- What the user is asking
- Which project context applies
- Whether the question is sufficiently specific
- Whether clarification is required
- What project information is relevant
- Whether data extraction is required
- Whether additional authorization is required

---

# 52. CLARIFICATION

The system must ask clarification questions only when genuinely necessary.

It must not ask unnecessary questions when sufficient information exists.

---

# 53. CLARIFICATION TYPES

The backend must support:

- Single-select clarification
- Multi-select clarification
- Free-text clarification

The response format must allow the UI to render the appropriate interaction.

---

# 54. CLARIFICATION BATCH (BACKEND) + ONE-AT-A-TIME (UI)

When multiple pieces of information are required, the **LLM / backend consolidates all clarification questions into a single payload** and returns them together (each question typed: single-select, multi-select, or free-text).

The **UI** presents those questions **one at a time** for user experience, collects answers locally, then submits **all answers in one request** back to the backend.

Example:

```text
Question
   ↓
Backend: clarification set { Q1, Q2, Q3 }  (single response)
   ↓
UI: ask Q1 → ask Q2 → ask Q3  (one at a time)
   ↓
UI: POST answers { Q1, Q2, Q3 }  (single payload)
   ↓
Final analysis
```

The backend must not require a separate round-trip per clarification question after the consolidated set has been issued. Persistence must keep the full clarification set and partial UI progress recoverable on refresh where appropriate.

---

# 55. CLARIFICATION PERSISTENCE

Clarification state must survive:

- Navigation
- Page refresh where appropriate
- Temporary connection interruption
- Chat reopening

The user should not lose an in-progress question.

---

# 56. QUESTION ROUTING

The backend must determine the appropriate processing path.

Conceptually:

```text
Question
   │
   ├── Project knowledge answer
   │
   ├── Source/code investigation
   │
   ├── Documentation investigation
   │
   ├── Cross-source analysis
   │
   ├── Database extraction (later slice; not current)
   │
   └── Clarification required
```

---

# 57. KNOWLEDGE RETRIEVAL

For questions requiring project information, retrieve relevant knowledge.

Retrieval should consider:

- User question
- Conversation context
- Project
- Relevant source versions
- Relevant documentation
- Relevant code
- Relevant functionality

For the current product slice:

- Supported code is retrieved from the project's current structural code graph.
- Markdown, MDX, and plain-text documentation are retrieved through project-scoped keyword/full-text
  search and bounded reads.
- Code and documentation retrieval do not use embeddings, vector search, or a reranker.
- An unavailable code graph must cause a grounded abstention or retryable knowledge error; the
  backend must not invent code behavior from general model knowledge.

---

# 58. FOLLOW-UP RETRIEVAL

For vague follow-up questions:

> I don't understand the second point.

the backend must use the existing conversation context to understand what:

> second point

refers to.

The user should not be forced to repeat the original question.

---

# 59. PREVIOUS ANSWER CONTEXT

Where appropriate, previous assistant responses and their evidence should be reusable as conversational context.

This is especially important for:

- Follow-ups
- Clarifications
- Corrections
- Deeper investigation

After project source changes, a continued conversation uses the current ready graph rather than a
historical graph snapshot. The backend must make this freshness transition visible and must retain
the original answer's recorded source/evidence metadata according to retention policy.

---

# 60. ANSWER GENERATION

Answers must be grounded in available project information.

The backend should distinguish between:

- Supported by project evidence
- Reasonable inference
- Unknown
- Insufficient information
- Conflicting information

The system must not confidently invent project behavior.

---

# 61. SOURCE REFERENCES

Responses should be able to include supporting source references.

A source reference should identify enough information for the UI to allow the user to inspect the evidence.

Possible information:

- Source
- File/document
- Relevant location
- Relevant section
- Relationship to answer

---

# 62. EVIDENCE TRACEABILITY

The backend should maintain a relationship:

```text
User Question
     ↓
Answer
     ↓
Evidence
     ↓
Project Source
```

This enables users to understand why an answer was produced.

---

# 63. SOURCE FRESHNESS

When an answer depends on source that has changed, the backend must consider source freshness.

If relevant knowledge is outdated:

- Refresh knowledge when possible
- Indicate stale state
- Avoid presenting known outdated information as current

---

# 64. MARKDOWN RESPONSE

The backend should return assistant responses in Markdown-compatible format.

The response structure must support:

- Headings
- Lists
- Tables
- Code blocks
- Inline code
- Links
- References
- Structured sections

---

# 65. RESPONSE STREAMING

If supported by the underlying execution model, the backend should support streaming response events.

The event lifecycle should allow the UI to distinguish:

- Started
- Processing
- Partial response
- Completed
- Failed
- Cancelled

---

# 66. EXECUTION STATUS

The backend must expose actual processing states when available.

Examples:

```text
Understanding question
Searching knowledge
Reviewing sources
Analyzing code
Generating query
Validating query
Executing query
Preparing response
```

These states must correspond to actual backend operations.

---

# 67. NO FAKE INTERNAL REASONING

The backend must never expose private chain-of-thought.

It may expose high-level execution stages, but not hidden internal reasoning.

---

# 68. TOKEN USAGE

Where supported, capture:

- Input token usage
- Output token usage
- Total token usage

Associate usage with:

- Message
- Conversation
- User
- Project
- Organization

Only report reliable values.

---

# 69. RESPONSE TIME

Record actual processing duration.

Where useful, expose:

- Total response time
- Relevant processing time

Do not fabricate timing.

---

# 70. CONTEXT CONSUMPTION

The backend must measure context consumption before every language-model call with the tokenizer
matching the active model artifact.

Associate it with the relevant conversation/message.

Each run must also have configurable cumulative input/output token, tool-result byte, and wall-time
budgets. The values must be selected through evaluation rather than guessed. There is no fixed
tool-round count, but exhausting any run budget must terminate the run with a structured error,
grounded partial answer, clarification, or abstention.

---

# 71. DATABASE QUERY REQUIREMENT

**Current product slice:** live query generation and execution against a customer
application database are **out of scope**. This section and §§72–82 are future
requirements, not acceptance criteria for this slice.

When that later slice is enabled, the backend must support questions that require
extracting information from project-related databases where such access is configured
and authorized.

Example:

> How many customers cancelled orders last month?

The system should determine:

1. Whether database information is required.
2. Which relevant data is needed.
3. Whether the user is authorized.
4. Whether sufficient schema information is available.
5. What query should be generated.
6. Whether the query is safe and valid.
7. Whether execution is permitted.
8. How results should be interpreted.

---

# 72. DATABASE UNDERSTANDING

Where database access is configured, the system must understand the available database structure sufficiently to map natural-language questions to relevant data.

The system should understand:

- Entities
- Tables
- Fields
- Relationships
- Relevant business meaning
- Data types
- Available environments

---

# 73. QUERY GENERATION

The backend must be able to generate an appropriate database query from a user's natural-language requirement.

Example:

> Show customers who cancelled an order last month.

The backend should translate this into a query based on the configured project data model.

---

# 74. QUERY VALIDATION

Before execution, generated queries must be validated.

Validation should consider:

- Syntax
- Referenced objects
- Permissions
- Query type
- Safety
- Environment
- Potentially destructive behavior

---

# 75. READ-ONLY SAFETY

If the platform is configured for read-only data access, the backend must enforce that restriction.

The system must not rely solely on the generated query behaving correctly.

---

# 76. QUERY AUTHORIZATION

Database query execution must respect:

- User permissions
- Project permissions
- Data access permissions
- Environment permissions
- Organization policies

---

# 77. QUERY APPROVAL

Where organizational policy requires approval, the backend must support:

```text
Question
   ↓
Query generated
   ↓
Query validated
   ↓
Approval required
   ↓
Approval granted
   ↓
Execution
   ↓
Result
```

The backend must maintain approval state.

---

# 78. QUERY EXECUTION

When execution is authorized, the backend should:

- Execute the validated query
- Capture execution status
- Capture duration
- Capture result metadata
- Return results safely
- Handle failures

---

# 79. QUERY RESULT LIMITS

Protect the system and users from accidentally retrieving extremely large datasets.

Support:

- Result limits
- Pagination
- Aggregation
- Truncation indicators

The user must know when results are incomplete.

---

# 80. QUERY RESULT INTERPRETATION

The backend should transform raw query results into an understandable response.

For example:

```text
1,842 customers cancelled orders last month.

The highest cancellation volume occurred in...
```

The raw result must remain available where appropriate.

---

# 81. QUERY AUDIT

Record:

- User
- Project
- Question
- Generated query
- Approval status
- Execution status
- Execution time
- Result size
- Environment

Sensitive data should not be unnecessarily copied into audit records.

---

# 82. QUERY FAILURE

If query generation or execution fails:

Explain:

- What failed
- Why it failed when known
- Whether retry is possible
- Whether clarification is required

Do not expose raw database errors as the only response.

---

# 83. SOURCE / KNOWLEDGE UPDATE IMPACT

When source changes, the backend should determine what project knowledge may be affected.

Example:

```text
17 files changed

Affected:
- Authentication workflow
- Customer API
- Login documentation

Unaffected:
- Reporting
- Payment workflow
```

Where possible, provide meaningful impact information.

---

# 84. KNOWLEDGE CONFLICTS

If source and documentation disagree, the backend should detect or represent the conflict where possible.

Example:

> Documentation describes authentication flow A, but current source implements flow B.

Do not silently choose one without appropriate handling.

---

# 85. KNOWLEDGE HEALTH

Maintain enough information to determine whether project knowledge is:

- Current
- Updating
- Stale
- Partial
- Failed
- Ready

---

# 86. AUDIT LOGGING

Enterprise operations must be auditable.

Audit important events including:

- User creation
- Role changes
- Permission changes
- Project creation
- Project deletion
- Source upload
- Repository connection
- Repository credential changes
- Knowledge updates
- Knowledge failures
- Conversation actions where required
- Database query generation (later slice; not current)
- Database query execution (later slice; not current)
- Approval actions
- Administrative actions

---

# 87. AUDIT DATA

Each audit event should include, where appropriate:

- Organization
- User
- Action
- Resource
- Timestamp
- Result
- Relevant context
- Source of action

Do not store sensitive information unnecessarily.

---

# 88. SECURITY

The backend must treat source code, documentation, project knowledge, conversations, and database information as potentially sensitive enterprise data.

Security must cover:

- Authentication
- Authorization
- Tenant isolation
- Project isolation
- Secure source handling
- Credential protection
- Access control
- Auditability
- Data protection
- Secure deletion

---

# 89. DATA ISOLATION

The backend must enforce isolation at every layer of data access.

A request must always be evaluated against:

```text
Organization
    ↓
User
    ↓
Role
    ↓
Project
    ↓
Resource
```

---

# 90. API AUTHORIZATION

Every protected backend operation must independently verify authorization.

Never assume:

> The UI wouldn't show this button.

The backend must reject unauthorized requests even if manually invoked.

---

# 91. RATE LIMITING

Protect backend operations from abuse.

Different operations may have different limits.

Examples:

- Authentication
- Source upload
- Knowledge processing
- Chat requests
- Search
- Database queries

Limits should not unnecessarily interfere with legitimate enterprise usage.

---

# 92. IDEMPOTENCY

Operations that may be retried must be safely repeatable.

Examples:

- Source uploads
- Knowledge processing
- Repository synchronization
- Query execution where applicable (later slice; not current)

The backend must prevent accidental duplicate operations caused by:

- Double clicks
- Network retries
- Browser retries
- Request timeouts

---

# 93. CONCURRENCY

The backend must safely handle multiple operations against the same project.

Examples:

```text
User A uploads source
User B asks a question
User C starts knowledge update
```

The system must maintain a consistent project state.

While the current code graph is being updated in place, project Q&A is unavailable. New questions
may be accepted into a durable queue with an explicit queued state; they must not execute against a
partially updated graph.

---

# 94. KNOWLEDGE UPDATE CONCURRENCY

Prevent conflicting knowledge updates from corrupting project knowledge.

If multiple updates are triggered simultaneously, the backend must define a deterministic behavior such as:

- Queueing
- Serialization
- Safe merging
- Conflict detection

The current product slice serializes code-graph writers per project. Indexing is controlled by the
background worker under a per-project lock; filesystem auto-watch must not publish source changes
outside the source-version job lifecycle.

If an in-place graph update fails, Q&A remains disabled while the worker rebuilds the graph from the
last successfully accepted source tree. Queued questions resume only after rebuild validation.

---

# 95. LONG-RUNNING OPERATIONS

Long-running work must not require the client to keep a single request open indefinitely.

The backend must provide a mechanism for:

- Starting an operation
- Tracking it
- Checking status
- Receiving progress
- Detecting completion
- Detecting failure
- Retrying

Questions queued behind a code-graph update must have a configurable expiry selected through
evaluation. On expiry, or when bounded graph recovery is exhausted, each queued message must become
failed with a structured, retryable knowledge-unavailable error.

---

# 96. INTERRUPTED CONNECTIONS

If the user loses connection during processing, the backend operation should continue where appropriate.

When the user reconnects, the current state should be recoverable.

---

# 97. BACKEND STATE CONSISTENCY

The backend must ensure the UI can always determine:

- Current project state
- Current knowledge state
- Current processing state
- Current conversation state
- Current query state

Avoid ambiguous states such as:

> Processing?

---

# 98. NOTIFICATIONS

The backend must generate notification events for important asynchronous events.

Examples:

- Knowledge completed
- Knowledge failed
- Repository update completed
- Processing requires attention
- Approval required
- Approval completed

---

# 99. USAGE TRACKING

Track usage at appropriate levels:

### Organization

- Questions
- Knowledge processing
- Source ingestion
- Query execution (later slice; not current)
- Token usage

### Project

- Questions
- Processing
- Source volume
- Query activity

### User

- Questions
- Processing initiated
- Query activity
- Token usage

---

# 100. USAGE ACCURACY

Usage metrics must be based on actual backend activity.

Do not estimate or fabricate usage.

---

# 101. RETENTION

The platform must support configurable retention policies for:

- Source
- Knowledge
- Conversations
- Audit logs
- Query history
- Processing history

Retention behavior must be explicit.

---

# 102. DELETION

Deletion must respect authorization and organizational policy.

Deleting a project must clearly define what happens to:

- Source
- Knowledge
- Conversations
- Query history
- Processing history
- Audit records

Sensitive data should be removed according to the applicable retention policy.

---

# 103. BACKUP / RECOVERY

Enterprise project state should be recoverable according to organizational requirements.

Critical metadata should not be lost because of a transient backend failure.

---

# 104. OBSERVABILITY

The backend must provide sufficient operational visibility to determine:

- Request failures
- Processing failures
- Knowledge failures
- Chat failures
- Query failures
- Authentication failures
- Performance problems
- Capacity problems

Operational diagnostics must not expose customer source code or sensitive data unnecessarily.

---

# 105. ERROR CORRELATION

For failures, the backend should generate a correlation/reference identifier that support teams can use to investigate.

Example:

> Something went wrong.

> Reference: `REQ-...`

The identifier must not expose sensitive information.

---

# 106. API DESIGN REQUIREMENT

Backend APIs should expose clear domain-oriented operations.

Conceptually support operations such as:

```text
Organizations
Users
Roles
Projects
Sources
Repositories
Processing Jobs
Knowledge
Search
Conversations
Messages
Queries
Approvals
Notifications
Usage
Audit
```

The API contract must provide structured responses and structured errors.

---

# 107. API VERSIONING

Backend APIs must support controlled evolution without unnecessarily breaking existing clients.

---

# 108. ASYNCHRONOUS EVENTS

The backend should support events for important state changes.

Examples:

```text
SourceUploaded
ProcessingStarted
ProcessingCompleted
ProcessingFailed
KnowledgeUpdated
RepositoryConnected
ConversationCreated
MessageCompleted
QueryGenerated
QueryApproved
QueryExecuted
```

The exact event model is implementation-dependent.

---

# 109. RETRY STRATEGY

Transient failures should be retried where appropriate.

Permanent failures should not be endlessly retried.

The backend must distinguish between:

- Temporary failure
- Permanent failure
- User-action-required failure

---

# 110. EXTERNAL SERVICE FAILURE

If an external dependency fails:

- Preserve user data
- Preserve project state
- Clearly indicate failure
- Retry where appropriate
- Avoid duplicate processing
- Recover when service becomes available

---

# 111. PROJECT IMPORT STATE

When repository import or upload is incomplete, the project should clearly represent its state.

The backend must never report:

> Knowledge Ready

until the required processing has actually completed.

---

# 112. KNOWLEDGE READINESS

Define clear readiness conditions.

A project may be:

> Ready

only when the required knowledge creation process has completed successfully.

Partial knowledge must be distinguishable from complete knowledge.

---

# 113. ANSWER RELIABILITY

The backend should prefer:

> I don't have enough information to answer this confidently.

over inventing project-specific information.

If evidence conflicts, the response should communicate the conflict.

---

# 114. PROJECT-SCOPED ANSWERS

Questions asked within a project must primarily use that project's knowledge.

The system must not accidentally answer a project question using information from another project.

---

# 115. CROSS-PROJECT ACCESS

If cross-project questions are supported in the future, they must require explicit authorization and context.

Cross-project information must never be included implicitly.

---

# 116. SUPPORT FOR NON-TECHNICAL USERS

The backend should provide enough structured information for the UI to explain technical concepts in understandable language.

The system should be capable of answering:

> What does this system do?

as well as:

> Where is this function implemented?

---

# 117. RESPONSE DEPTH

The backend should support answering at different levels of detail based on the user's question.

Examples:

> Short explanation

> Detailed technical explanation

> Step-by-step workflow

> Code-level explanation

The response should match the question rather than always returning maximum detail.

---

# 118. FOLLOW-UP QUESTION QUALITY

Follow-up questions must use conversation context.

Example:

```text
User:
Explain authentication.

Assistant:
...

User:
What about the second step?

Assistant:
...
```

The backend should understand the reference without forcing the user to restate the context.

---

# 119. CHAT STATE RECOVERY

If a conversation is interrupted while a response is being generated, the backend must provide a recoverable state.

Possible states:

- Generating
- Completed
- Failed
- Cancelled
- Interrupted

The UI should not display an indefinitely spinning message.

---

# 120. STREAM INTERRUPTION

If streaming is interrupted, the backend should distinguish:

> Response completed

from:

> Response interrupted.

---

# 121. DATABASE ACCESS CONFIGURATION

**Current product slice:** customer database access configuration, credentials, and
environments are **out of scope**. §§121–126 are future requirements.

When that later slice is enabled, projects requiring database-backed answers must
support configuration of the relevant data source and environment.

The backend must associate database access with the project.

Access must be explicitly authorized.

---

# 122. DATABASE ENVIRONMENTS

Where multiple environments exist, the backend must clearly distinguish them.

Examples:

- Development
- Staging
- Production

Production access should be governed by stricter authorization where required.

---

# 123. DATABASE CREDENTIAL SECURITY

Database credentials must:

- Never be returned to clients
- Never appear in normal logs
- Be securely managed
- Be scoped appropriately
- Be revocable
- Be testable

---

# 124. DATABASE QUERY SAFETY

The backend must prevent unauthorized or unsafe database operations.

Where only read access is permitted, enforce it independently of generated query content.

---

# 125. QUERY EXPLANATION

The backend should provide enough structured information for the UI to explain:

- What data was requested
- Which data sources were used
- What query was generated
- What assumptions were made
- Whether execution occurred
- What results were returned

---

# 126. QUERY ASSUMPTIONS

If interpretation requires an assumption, represent it explicitly.

Example:

> "Last month" interpreted as the previous calendar month.

The user should be able to understand what interpretation was used.

---

# 127. UNKNOWN DATA

If required data is unavailable:

> The project does not currently contain enough information to answer this question.

The system should identify what is missing where possible.

---

# 128. DOCUMENTATION VS CODE CONFLICT

When documentation and code disagree, the backend should preserve enough evidence for the response to explain the discrepancy.

Example:

> Documentation says X, but the current implementation does Y.

---

# 129. KNOWLEDGE SOURCE TRACEABILITY

Knowledge items should be traceable to their underlying sources.

Conceptually:

```text
Knowledge Item
      ↓
Source Evidence
      ↓
File / Document
      ↓
Source Version
```

This allows users to verify important information.

---

# 130. PROJECT KNOWLEDGE API

The backend must provide project knowledge access for the UI.

The UI should be able to retrieve:

- Project summary
- Capabilities
- Workflows
- Services
- APIs
- Functions
- Documentation
- Integrations
- Data concepts
- Relationships
- Knowledge health

---

# 131. SEARCH API

Project search must support:

- Search query
- Project scope
- User authorization
- Result type
- Relevance
- Source reference

Results should be structured so the UI can distinguish different result types.

---

# 132. SEARCH + CHAT

Search results should support:

> Ask about this

The backend should be able to pass the selected search result into the current conversation context.

---

# 133. SOURCE PREVIEW API

The backend must provide authorized access to relevant source/document content.

It should support retrieving only the required content rather than unnecessarily exposing entire projects.

---

# 134. AUDITABILITY OF SOURCE ACCESS

Where required by enterprise policy, track sensitive source access.

Examples:

- User viewed source
- User viewed documentation
- User downloaded source
- User accessed sensitive data

---

# 135. ADMINISTRATIVE CONTROLS

Administrators should be able to manage:

- Users
- Roles
- Projects
- Access
- Repository configuration
- Data source configuration
- Retention
- Usage
- Audit information

---

# 136. ADMIN OPERATIONS

Administrative operations must be permission-protected and auditable.

---

# 137. SYSTEM CONFIGURATION

Organization/project configuration must be separated from application behavior.

Configuration should support controlled changes and clear ownership.

---

# 138. ENTERPRISE SCALABILITY

The backend must be designed to support enterprise workloads involving:

- Many organizations
- Many users
- Many projects
- Large source repositories
- Large documentation sets
- Large knowledge bases
- Large conversation histories
- Concurrent users
- Concurrent processing jobs

No specific infrastructure or technology is prescribed.

---

# 139. LARGE PROJECT SUPPORT

The backend must support projects significantly larger than a small sample application.

**Design baseline target:** ~**2M lines of code**, plus Markdown/MDX/plain-text documentation.
The selected structural code indexer currently excludes files larger than **1 MiB**. Such files may
be accepted as source, but they must be listed as excluded and force knowledge health to
`partially_available`.

It must not assume:

- Small source repositories
- Small file counts
- Short conversations
- Small documentation
- Single-user access
- Files small enough to prompt in one piece

No complete source file or document may be inserted into a prompt without passing the context
budget. Code-graph results and document reads must remain project-scoped, bounded, and attributable
to source locations.

---

# 140. CONCURRENT CHAT

Multiple users may ask questions about the same project simultaneously.

The backend must isolate conversation state while sharing the appropriate project knowledge.

Example:

```text
Project A
 ├── User 1 → Conversation 1
 ├── User 2 → Conversation 2
 └── User 3 → Conversation 3
```

---

# 141. KNOWLEDGE SHARING

Project knowledge should be shared according to project permissions.

Conversation context must remain user/conversation-specific unless explicitly shared.

Do not accidentally make one user's private conversation context available to another user.

---

# 142. CONVERSATION ISOLATION

A user's conversation must not automatically become project knowledge.

Project knowledge and conversational context must remain conceptually separate.

```text
Project Knowledge
       │
       ├── Available to authorized users
       │
       ▼
Conversation
       │
       └── Private conversational context
```

---

# 143. KNOWLEDGE VS CONVERSATION

The backend must maintain a clear distinction:

### Project Knowledge

Persistent understanding derived from project sources.

### Conversation

User-specific interaction and context about that knowledge.

A conversation must not silently modify authoritative project knowledge.

---

# 144. PROJECT UPDATE + ACTIVE CHAT

If project knowledge changes while a user has an active conversation, the backend should track which knowledge state the conversation has been using.

This prevents ambiguity when a user asks:

> Is this still true after today's update?

The current product slice keeps only the current code graph. During an in-place graph update, Q&A is
disabled and new questions are queued. After a successful update, continued conversations use the
new current graph and expose that freshness transition.

---

# 145. KNOWLEDGE VERSION AWARENESS

Where relevant, the system should be able to determine:

> This answer was based on knowledge version X.

This supports enterprise traceability.

The version record and answer evidence metadata are retained according to policy, but historical
code-graph indexes are not retained. The backend must not claim that an old graph can be queried or
reconstructed unless that capability is added later.

---

# 146. RESPONSE TRACEABILITY

For important responses, the backend should record:

```text
User
 ↓
Question
 ↓
Conversation Context
 ↓
Knowledge Version
 ↓
Sources
 ↓
Processing
 ↓
Answer
```

This is important for enterprise debugging and auditing.

Reconstruction is limited by source and evidence retention. Because only the current code graph is
kept, historical graph traversal is not guaranteed.

---

# 147. DATA PRIVACY

The backend must minimize unnecessary collection and retention of sensitive data.

Data should only be accessible to users and services with appropriate authorization.

---

# 148. SECRET PROTECTION

Never expose:

- Repository credentials
- Database credentials
- Authentication secrets
- Internal credentials
- Sensitive configuration

through:

- API responses
- Logs
- Errors
- Audit records
- Chat responses

unless explicitly authorized and necessary.

---

# 149. LOGGING

Operational logging must be sufficient for debugging without unnecessarily logging:

- Source code
- Credentials
- Personal data
- Database results
- Conversation contents

Sensitive information should be protected or omitted.

---

# 150. ENTERPRISE AUDIT REQUIREMENT

All security-sensitive and administrative operations must have auditable records.

Audit records should be immutable according to the organization's policy.

---

# 151. BACKEND RELIABILITY

The backend must be resilient to:

- Temporary service failures
- Network failures
- Processing failures
- Repository failures
- Partial uploads
- Interrupted clients
- Duplicate requests

The system should recover automatically where appropriate.

---

# 152. USER-FACING STATE MUST BE AUTHORITATIVE

The backend must be the source of truth for:

- Project status
- Processing status
- Knowledge status
- Conversation status
- Query status
- Approval status

The frontend must not invent or maintain authoritative business state.

---

# 153. CONSISTENT STATE TRANSITIONS

Define valid transitions for major resources.

Example:

```text
Processing:
Pending
  ↓
Running
  ↓
Completed

or

Running
  ↓
Failed
  ↓
Retrying
  ↓
Running
```

Invalid transitions must be rejected.

---

# 154. BACKEND REQUIREMENT FOR PREMIUM UX

The backend must provide enough structured state for the frontend to deliver the premium UI experience.

Every major asynchronous process should provide meaningful:

- State
- Progress
- Error
- Result
- Timestamp
- Retry state

The UI should never have to infer complex backend state from arbitrary messages.

---

# 155. FINAL END-TO-END BACKEND FLOW

The complete backend flow should support:

```text
Organization
      ↓
User
      ↓
Role / Permission
      ↓
Create Project
      ↓
Upload Source / Connect Repository
      ↓
Validate Source
      ↓
Retrieve Source
      ↓
Create Processing Job
      ↓
Analyze Source + Documentation
      ↓
Create / Update Project Knowledge
      ↓
Validate Knowledge
      ↓
Knowledge Ready
      ↓
User Opens Chat
      ↓
Create / Continue Conversation
      ↓
Receive Question
      ↓
Understand Question
      ↓
Use Conversation Context
      ↓
Determine Required Information
      │
      ├── Enough Information
      │        ↓
      │   Retrieve Knowledge
      │        ↓
      │   Analyze
      │        ↓
      │   Generate Answer
      │
      └── Missing Information
               ↓
          Generate Clarification
               ↓
          Receive User Answer
               ↓
          Continue Analysis
      ↓
Determine Whether Database Access Is Required
      │  (later slice; not current — skip this branch)
      ├── No
      │    ↓
      │  Generate Answer
      │
      └── Yes
           ↓
      Determine Required Data
           ↓
      Generate Query
           ↓
      Validate Query
           ↓
      Check Authorization
           ↓
      Approval if Required
           ↓
      Execute Query
           ↓
      Interpret Results
           ↓
      Generate Answer
      ↓
Attach Evidence
      ↓
Record Metrics
      ↓
Persist Conversation
      ↓
Return Response
```

---

# 156. NON-NEGOTIABLE BACKEND REQUIREMENTS

1. Multi-tenant SaaS architecture.
2. Strong organization isolation.
3. Project-level access control.
4. Role-based authorization.
5. Backend-enforced permissions.
6. User creation and administration.
7. Password reset support.
8. Multiple project source uploads.
9. Folder upload support where available.
10. ZIP upload support.
11. GitHub repository connection.
12. GitLab repository connection.
13. Repository authentication handling.
14. Branch retrieval and selection.
15. Repository synchronization/update support.
16. Source version tracking.
17. Documentation ingestion.
18. Project source analysis.
19. Code understanding.
20. Functional/business understanding.
21. Persistent project knowledge.
22. Incremental knowledge updates.
23. Knowledge versioning.
24. Knowledge freshness tracking.
25. Processing jobs.
26. Processing progress.
27. Human-readable processing events.
28. Persistent processing failures.
29. Retry support.
30. Partial-processing support.
31. Persistent project conversations.
32. Conversation context.
33. Follow-up question understanding.
34. Clarification batch from backend; UI asks one-at-a-time then returns all answers in one payload.
35. Single-select clarification.
36. Multi-select clarification.
37. Free-text clarification.
38. Editable previous messages.
39. Conversation archiving.
40. Conversation restoration.
41. Conversation search.
42. Project-scoped chat.
43. Evidence/source traceability.
44. Markdown-compatible responses.
45. Streaming support where actually available.
46. Real execution-state reporting.
47. No fabricated thinking/progress/tool execution.
48. Actual token usage where available.
49. Actual response timing where available.
50. Actual context usage where available.
51. Database question understanding. **(future; not this slice)**
52. Database query generation. **(future; not this slice)**
53. Query validation. **(future; not this slice)**
54. Query authorization. **(future; not this slice)**
55. Query approval workflow. **(future; not this slice)**
56. Safe query execution. **(future; not this slice)**
57. Query result limits. **(future; not this slice)**
58. Query auditing. **(future; not this slice)**
59. Project/knowledge/source version traceability.
60. Conflict detection between source and documentation where possible.
61. Comprehensive audit logging.
62. Secure credential handling.
63. Secure source handling.
64. Strong tenant isolation.
65. Rate limiting.
66. Idempotent operations.
67. Concurrent-operation handling.
68. Long-running operation management.
69. Connection-loss recovery.
70. Structured backend errors.
71. Structured processing states.
72. Notifications for important asynchronous events.
73. Usage tracking.
74. Retention controls.
75. Secure deletion.
76. Enterprise-scale project support.
77. Concurrent-user support.
78. Conversation isolation.
79. Knowledge/conversation separation.
80. Authoritative backend state.
81. Reliable recovery from transient failures.
82. End-to-end traceability for important answers.
83. No cross-project information leakage.
84. No cross-tenant information leakage.
85. No unnecessary exposure of source code or sensitive data.

---

# 157. FINAL BACKEND OBJECTIVE

The backend should make the entire platform behave as a **persistent software intelligence system**, not simply as a chatbot with uploaded files.

The system must maintain a reliable relationship between:

```text
Organization
    ↓
Project
    ↓
Source
    ↓
Source Version
    ↓
Knowledge
    ↓
Conversation
    ↓
Question
    ↓
Evidence
    ↓
Answer
    ↓
Database Query when required (later slice; not current)
    ↓
Audit / Traceability
```

The backend must provide enough structure, state, security, traceability, and reliability for the frontend to deliver the intended premium enterprise experience.

The most important principle is:

> **The system should understand the project continuously as the source evolves, while allowing users to have persistent, context-aware conversations with that understanding.**

The platform should never require users to manually manage the complexity of source ingestion, knowledge updates, retrieval, context management, clarification, evidence gathering, or database extraction unless their explicit decision or authorization is required.
