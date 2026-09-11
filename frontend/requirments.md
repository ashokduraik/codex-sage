# Enterprise Software Intelligence Platform — Complete UI/UX Requirements

## 1. Purpose

Design a premium, enterprise-grade SaaS product that allows organizations to upload or connect their software source code and documentation, build an understandable knowledge representation of the project, and interact with that knowledge through a conversational interface.

The primary user experience is:

> **Connect or upload a project → understand the project → ask anything → receive a grounded answer → inspect evidence → continue the conversation.**

The product must support:

* Engineering teams
* Product and business teams
* Support teams
* Operations teams
* Enterprise administrators

The UI/UX must be designed for both technical and non-technical users.

---

# 2. UI/UX SCOPE

This specification defines the UI/UX only.

Do not make assumptions about or prescribe:

* Programming languages
* Frontend frameworks
* Backend technologies
* Databases
* AI/LLM providers
* AI models
* Cloud providers
* Infrastructure
* Deployment architecture
* Search technologies
* Knowledge implementation
* Agent implementation

The design must remain technology-independent.

### Current product slice — out of scope for the UI

Do not present these as available capabilities. They are later-slice requirements
only. Per §98, the UI must not show states or actions the product cannot perform.

* Live query generation, approval, execution, or results against a **customer
  application database** (§§75–78)
* Customer-database environment switcher
* Database-query permissions, usage metrics, and approval notifications as live
  product features
* “Database-driven answers” as a current-slice promise (§104)
* Image upload / image-as-source processing (align with backend current slice)
* Cross-project questions unless the backend explicitly enables and authorizes them

Questions about live application data in Chat must follow whatever the backend
returns (for example not enough information). Do not open a query-approval flow.

---

# 3. CORE UX PRINCIPLES

The product must follow these principles:

* Premium
* Enterprise-grade
* Extremely user-friendly
* Minimal clicks
* Minimal configuration
* Intelligent defaults
* Progressive disclosure
* Clear visual hierarchy
* Context-aware interactions
* Fast perceived performance
* Strong loading states
* Strong error states
* Strong empty states
* Strong success states
* Accessible
* Responsive
* Mobile-friendly
* Technically credible

The UI must absorb complexity rather than transferring complexity to the user.

If the system can determine something automatically, do not ask the user to configure it manually.

---

# 4. VISUAL DESIGN

The visual design should feel:

* Premium
* Modern
* Sophisticated
* Clean
* Intelligent
* Calm
* Trustworthy
* Professional

Avoid:

* Generic chatbot styling
* Basic CRUD-dashboard appearance
* Excessive cards
* Excessive borders
* Excessive gradients
* Excessive animations
* Unnecessary configuration controls
* Visual clutter
* Artificial futuristic AI styling

The product should look appropriate for a large enterprise while still feeling modern.

---

# 5. TARGET USER EXPERIENCE

The product should work naturally for:

### Engineering

Users need to understand:

* Source code
* Functions
* Classes/components
* APIs
* Dependencies
* Data flow
* Implementation
* Architecture
* Technical behavior

### Product / Business

Users need to understand:

* Product functionality
* Business rules
* Capabilities
* Workflows
* Customer behavior

### Support / Operations

Users need to understand:

* Application behavior
* Troubleshooting
* Operational workflows
* Relevant technical context
* Data-related information

### Administrators

Users need to manage:

* Users
* Roles
* Permissions
* Projects
* Access
* Usage
* Audit information
* Organization settings

---

# 6. APPLICATION SHELL

Provide a consistent application shell.

Desktop navigation should provide access to:

* Home
* Projects
* Chat
* Knowledge
* Search
* Conversations
* Administration

Where the user is not signed in, only the authentication experience is available.

The current organization and project should always be clear when signed in.

Support:

* Expanded navigation
* Collapsed navigation

Do not overload navigation with unnecessary options.

---

# 7. GLOBAL HEADER

The header should provide:

* Organization
* Current project
* Global search
* Notifications
* User profile
* Relevant contextual actions

Keep the header lightweight.

---

# 7A. AUTHENTICATION AND SESSION

Provide a clear sign-in experience for organization users.

Support:

* Sign in
* Sign out
* Session expiry / re-authentication when the backend requires it
* Password change for the signed-in user where permitted
* Password reset initiation for the signed-in user where permitted
  (distinct from administrator-initiated reset in §84)

When the session is invalid or expired:

* Stop treating the user as signed in
* Return them to sign-in without exposing protected project content
* Preserve enough context to resume after successful re-authentication where safe

Do not invent authentication providers or flows the backend does not support.

---

# 8. HOME DASHBOARD

The Home screen should be action-oriented.

Primary message:

> Understand your software system.

Primary action:

> Ask anything about your project

Show:

### Recent Projects

Projects recently accessed.

### Recent Conversations

Conversations that can be continued.

### Knowledge Status

Examples:

* Ready
* Updating
* Needs attention
* Outdated

### Suggested Starting Questions

Examples:

* Explain this project
* How does authentication work?
* Explain the checkout flow
* Where is payment implemented?
* What changed recently?

The primary visual focus should be on understanding the project, not generic analytics.

---

# 9. PROJECT CREATION

Project creation must be extremely simple.

Primary options:

> Upload Project

or

> Connect Repository

The ideal flow is:

> Create Project → Provide Source → Start Understanding

Do not create a long configuration wizard.

Use progressive disclosure for advanced settings.

### Project lifecycle states

The UI must clearly represent the project’s current state using the backend’s
authoritative states. Do not invent states. Expected states include:

* Creating
* Awaiting source
* Connecting repository
* Source received
* Processing
* Knowledge ready
* Updating
* Failed
* Partially available
* Archived

Home, Project Overview, and related badges must distinguish **Ready** from
**Partially available**, and must never show **Knowledge ready** while import or
required processing is incomplete.

---

# 10. GITHUB / GITLAB REPOSITORY CONNECTION

Provide an **Attach / Connect Repository** flow for an existing project (and as
a path during project creation).

Support:

* GitHub
* GitLab.com
* Self-hosted GitLab instances

The user provides a **repository URL**. The UI must **not** ask the user to
pick the provider — the backend probe must infer `github` or `gitlab` from the
URL (and return a base URL for self-hosted GitLab).

URL step hint example:

> Supports GitHub and GitLab, including self-hosted GitLab instances.

### Connection flow (minimal clicks)

Use a short multi-step experience:

1. **URL** — user enters the repository URL and chooses Connect
2. **Probe** — system attempts access without a token first
3. **Token** — only if authentication is required (private or gated repo)
4. **Confirm** — show repository identity, selectable branches, then Connect

Do not open a long configuration wizard.

Show clear connection / probe states:

* Connecting / Verifying
* Connected
* Authentication required
* Repository not found
* Access denied
* Connection failed / unreachable

Example probe errors (user-facing):

> Repository not found. Check the URL or your access token.

> Could not reach the repository. Check the URL and try again.

---

# 11. REPOSITORY BRANCH SELECTION

After a successful probe (public, or authenticated):

* Retrieve available branches from the backend probe result
* Display them for selection (for example as a list or control)
* Default to the probe’s default branch when provided
* Show the selected branch clearly
* Allow changing it before final attach / processing

Example:

> Repository connected successfully

> Branch

[ main ▼ ]

The user should not manually type the branch name if the system can retrieve it.

Optional confirm-step fields when the backend provides them (for example a
README-derived description) may be shown and edited before Connect. Do not
require fields the backend does not support.

---

# 12. REPOSITORY AUTHENTICATION

If the probe reports authentication required, explain why using the repository
identity when available.

Example:

> acme/payments looks private or requires authentication.

Then collect:

> Access Token

(password-style input; never echo the value later)

Provide **Back** (to URL) and **Continue** (re-probe with token).

If Continue is pressed with an empty token:

> Enter an access token to continue.

### Inline token help (required)

When the token step is shown, display provider-specific instructions **inline**
(not only a bare external link). Cover:

1. Why a token is required
2. What kind of credential (personal access token)
3. Exact navigation path to create it
4. Minimum required scope / permission
5. How to paste it and continue
6. That the token is used only to connect this repository

Do not assume users know how repository credentials work.

#### GitHub

Title example:

> Get a GitHub access token

Steps:

1. Open GitHub → Settings → Developer settings → Personal access tokens.
2. Click “Generate new token” (classic) and give it a name.
3. Select the **`repo`** scope so the product can read private repositories
   (request only scopes the backend actually needs for connection and source
   retrieval; do not ask for unused scopes).
4. Generate the token and paste it into Access Token.

Primary action link:

> Open token page → `https://github.com/settings/tokens/new`

#### GitLab.com

Title example:

> Get a GitLab access token

Steps:

1. Open GitLab → your avatar → Edit profile → Access Tokens.
2. Give the token a name and select the **`api`** scope (or the minimum scope
   the backend requires for repository access).
3. Create the token and paste it into Access Token.

Primary action link:

> Open token page → `https://gitlab.com/-/user_settings/personal_access_tokens`

#### Self-hosted GitLab

Same guidance as GitLab.com, labeled **GitLab (self-hosted)**, with step 1
starting from the user’s instance.

Primary action link must use the probe’s instance base URL:

> `{baseUrl}/-/user_settings/personal_access_tokens`

Example:

> `https://gitlab.example.com/-/user_settings/personal_access_tokens`

---

# 13. TOKEN PAGE AND DOCUMENTATION LINKS

When credentials need to be created, the primary link must open the provider’s
**token creation page** (as in §12), not a generic marketing page.

Optional secondary links to official GitHub/GitLab documentation may be added
for deeper help, but they must not replace the inline steps or the token-page
link.

The experience should be:

> See how to create a token → Open token page → Create credential → Return →
> Enter credential → Verify / Continue → Confirm branch → Connect

Clearly explain minimum required permissions.

Do not request unnecessary permissions.

---

# 14. REPOSITORY CONNECTION VALIDATION

After credentials are supplied, re-probe / validate the connection before final
attach.

Success:

> ✓ Repository access verified

(or advance directly to the Confirm step with repository name and branches)

Failure:

> We couldn't access this repository.

Provide an understandable reason and next action (fix URL, replace token, or
retry).

Do not expose raw technical errors as the primary message.

Never display stored repository credentials or secrets after they have been
saved. Credential fields are write-only after save (masked or empty).

---

# 14A. REPOSITORY CREDENTIAL LIFECYCLE

After a repository is connected, authorized users must be able to manage
credentials from project Sources / settings without recreating the project.

Provide:

* Replace credentials (reuse the same inline token help as §12 for the provider)
* Revoke / disconnect repository access where permitted
* Re-test / re-probe connection after replacement

Explain why re-authentication is required when access fails later.

Never redisplay the previous secret value.

---

# 15. SOURCE UPLOAD

Support:

* Multiple file uploads
* Multiple uploads over time
* Folder upload
* ZIP upload
* Drag and drop
* File selection

The same project must be able to receive additional source code and documentation later.

Uploading additional source must feel like:

> Update project knowledge

rather than:

> Create another project.

---

# 16. FOLDER UPLOAD

Where supported, allow users to upload an entire project folder.

Example:

> Upload project folder

Support drag-and-drop and folder selection.

Automatically exclude unnecessary project content.

For Node.js projects:

> `node_modules` will be excluded automatically.

The user should not need to manually clean the project.

---

# 17. ZIP FALLBACK

If folder upload is not supported by the environment:

> Folder upload isn't supported in this environment.

> Compress your project into a ZIP file and upload it instead.

[Upload ZIP]

Provide simple instructions.

Do not make users understand browser limitations.

---

# 18. UPLOAD PREVIEW

Before processing, show:

* File count
* Folder count
* Excluded items
* Size
* Important exclusions

Example:

> Project ready to upload

```text
4,821 files
624 folders
1,203 excluded
184 MB
```

Allow immediate continuation.

Avoid unnecessary configuration.

### Upload validation and rejection

Before or during upload, surface backend validation failures clearly:

* Unsupported or corrupt format
* Size constraint exceeded
* Archive integrity failure
* Unsafe paths
* Other user-correctable source errors

If the upload format **cannot** be path-filtered (opaque formats where
`node_modules` and similar cannot be excluded automatically), reject the upload
with a clear remediation:

> We couldn’t safely exclude dependency folders from this upload.

> Remove `node_modules` (and similar build/dependency folders), then re-upload
> as a ZIP or folder.

Do not proceed into knowledge processing as if the upload succeeded.

---

# 19. UPLOAD PROGRESS

During upload show:

* Overall progress
* Current state
* Files processed
* Size
* Remaining work where available

Example:

> Uploading project

> 1,842 / 4,821 files

[████████░░] 72%

Clearly distinguish:

* In progress
* Completed
* Failed
* Partially completed

---

# 20. KNOWLEDGE CREATION

Knowledge creation must have a clear, understandable progress experience.

Example:

> Understanding your project

```text
✓ Source received
✓ Project files identified
✓ Documentation identified
✓ Project structure understood
● Understanding application functionality
○ Connecting related components
○ Updating project knowledge
○ Finalizing
```

Show progress only where meaningful.

Do not expose raw processing logs.

---

# 21. KNOWLEDGE ACTIVITY LOG

Provide a detailed activity view.

Example:

```text
10:42:11  Project files identified
10:42:18  Documentation analyzed
10:42:32  Authentication functionality identified
10:43:01  Checkout workflow analyzed
10:43:19  Project knowledge updated
```

Use human-readable messages.

Do not expose internal IDs or raw system logs as the primary experience.

---

# 22. PERSISTENT PROCESSING STATUS

Knowledge processing must remain visible when the user navigates away.

Provide a persistent application-level status indicator.

Example:

> ⟳ Knowledge update · 68%

The user should be able to open the processing details from anywhere within the application.

---

# 23. PROCESSING CENTER

The processing center should show:

* Current operation
* Progress
* Completed stages
* Current stage
* Pending stages
* Warnings
* Errors
* Completion status
* Start time
* Completion time
* Retry availability

---

# 24. PROCESSING ERRORS

Any knowledge creation failure must remain visible after the user navigates elsewhere.

Example:

> ⚠ Knowledge update needs attention

Make the status accessible from:

* Global navigation
* Project overview
* Knowledge screen
* Processing center

---

# 25. UNDERSTANDABLE ERRORS

Do not show only raw technical errors.

Instead of:

> PROCESSING_NODE_ERROR_48392

show:

> **12 files could not be analyzed**

Then:

> The rest of the project was successfully processed. These files require attention.

When the backend reports partial processing, prefer explicit counts:

> 4,812 files processed successfully.

> 9 files failed.

Then state whether project knowledge is **complete** or **partial**, and whether
asking questions is paused, queued, or available (use the backend state).

Actions:

[View Details]

When the backend provides a support correlation / reference identifier, show it
on serious failures (for example `Reference: REQ-…`) so users can share it with
support. Do not invent reference IDs.

---

# 26. ERROR DETAILS

Show:

* What failed
* Why it failed, when known
* Affected items
* What succeeded
* Whether asking questions is paused, queued, or available (use the backend state;
  do not assume the previous map is still askable)
* Recommended action

While a code-map update or recovery is in progress, or after it failed mid-update,
do **not** tell the user that existing knowledge remains usable for new questions.

---

# 27. RETRY

Recoverable processing failures must have:

> Retry

Where possible, retry only the failed portion.

If a complete retry is required, explain why.

Retry must remain available from relevant locations.

---

# 28. PROCESSING HISTORY

Show previous knowledge-processing operations.

Example:

```text
✓ Today, 10:42 AM
  Completed

⚠ Yesterday, 4:18 PM
  Completed with warnings

✕ July 29, 2:31 PM
  Failed
```

Users should be able to inspect details of previous operations.

---

# 29. KNOWLEDGE COMPLETION

When processing finishes:

> ✓ Your project is ready to explore.

Provide:

[Ask a Question]

[Explore Knowledge]

[View Project Overview]

---

# 30. PROJECT OVERVIEW

The Project Overview should provide an intelligent briefing.

Include:

### Project Summary

What the application does.

### Capabilities

Major functionality.

### Workflows

Important business/application workflows.

### Components

Major components or services.

### APIs

Important APIs.

### Data

Relevant data areas.

### Integrations

External systems.

### Knowledge Health

Current knowledge state.

The screen should feel like an intelligent project briefing rather than a generic dashboard.

---

# 31. PROJECT CHAT MODEL

Chat must be an **embedded workspace inside the project application**.

Chat must NOT be:

* A popup
* A modal
* A floating window
* A bottom popup
* A bottom drawer
* An overlay

When the user selects Chat from Project Overview, Chat should occupy the main project content area.

The application shell and project identity remain intact.

---

# 32. EMBEDDED CHAT LAYOUT

Desktop Chat should use a two-panel layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Project / Application Header                                 │
├──────────────┬───────────────────────────────────────────────┤
│              │                                               │
│ Conversation │              Active Conversation              │
│ History      │                                               │
│              │                                               │
│ + New Chat   │ User: How does checkout work?                  │
│              │                                               │
│ Recent       │ Assistant: ...                                │
│              │                                               │
│ Checkout     │ User: Where is payment handled?              │
│ flow         │                                               │
│              │ Assistant: ...                                │
│ Payment      │                                               │
│ issue        │                                               │
│              ├───────────────────────────────────────────────┤
│ Archived     │ Ask anything about this project...        ↑  │
└──────────────┴───────────────────────────────────────────────┘
```

Left:

> Conversation History

Right:

> Active Chat

---

# 33. CHAT HISTORY

The left side of Chat must permanently provide conversation history on desktop.

Show:

### New Chat

[+ New Chat]

### Recent

* Checkout flow
* Authentication implementation
* Payment investigation
* Customer cancellation

### Archived

* Legacy checkout
* Old authentication
* Previous investigations

The history panel should remain easily accessible without opening another screen.

---

# 34. CONVERSATION SELECTION

Selecting a conversation loads it into the main Chat area.

Do not navigate to a separate page.

The selected conversation should have a clear visual state.

---

# 35. CONTINUE PREVIOUS CHAT

Users must be able to return to any previous non-deleted conversation and continue it.

Example:

Previous:

> How does checkout work?

Later:

> What happens if payment fails?

The system should continue using the previous conversation context.

### Chat while knowledge is updating

While the project’s code map is updating or being rebuilt:

* Show that knowledge is updating
* If the user sends a question, show it as **queued** (waiting), not as a live answer
* Do not imply the previous map is still available to ask
* When the backend marks knowledge ready or partial again, continue queued questions or
  show a retryable “knowledge unavailable” error if the wait expired

If a repository check fails **before** any map rewrite, existing knowledge may still
be used for Chat.

After a successful update, continued Chat uses the new current knowledge. Show a
clear notice that knowledge changed. Keep evidence attached to older answers.

Where the backend provides knowledge-version metadata, show which knowledge /
source version grounded the answer (for example “Based on knowledge version …”).
Do not claim that historical code-graph indexes can still be queried unless the
backend supports that.

---

# 36. CONVERSATION CONTEXT

A conversation should remain usable until the supported context capacity is reached.

Do not impose an arbitrary UI-level message limit.

The system should preserve:

* Previous user questions
* Previous assistant responses
* Clarifications
* Answers
* Relevant conversational context

---

# 37. CONTEXT LIMIT

When a conversation approaches its supported context capacity, show a clear warning.

Example:

> **This conversation is getting long.**

> Older context may need to be summarized to continue.

If automatic context management is available, use it naturally.

If user action is required, explain the available options.

---

# 38. CONTEXT METRICS

If reliable information is available, show subtle context metadata.

Example:

> Context · 82%

Do not fabricate values.

---

# 39. CHAT HISTORY SEARCH

For projects with many conversations, allow users to search previous conversations.

Example:

> Search conversations...

Results should show relevant conversation titles and previews.

Selecting a result should immediately open that conversation.

---

# 40. NEW CHAT

Provide:

> * New Chat

Creating a new conversation must not remove existing conversations.

Automatically focus the composer.

---

# 41. ARCHIVE CHAT

Users must be able to archive old conversations.

Provide an unobtrusive action:

> ··· → Archive

Archiving must not delete the conversation.

---

# 42. ARCHIVED CHAT

Archived conversations should remain accessible.

Users can:

* View
* Continue
* Restore
* Delete where permitted

---

# 43. CONVERSATION MANAGEMENT

Users should be able to:

* Continue
* Rename
* Search
* Archive
* Restore
* Delete where permitted

Keep these actions unobtrusive.

---

# 44. ACTIVE CHAT AREA

The active conversation should include:

* Conversation title
* Project identity
* User messages
* Assistant responses
* Clarifications
* Activity status
* Evidence
* Composer

The conversation should support very long discussions without becoming difficult to navigate.

---

# 45. CHAT COMPOSER

The composer should remain at the bottom of the active Chat area.

Placeholder:

> Ask anything about this project...

Support:

* Multi-line input
* Keyboard interaction
* Long questions
* Mobile touch interaction

The composer should expand naturally.

---

# 46. GENERIC CHAT

The user should not need to select a question category.

They can ask anything related to the project:

* Code
* Function
* Architecture
* Business functionality
* Documentation
* Workflow
* API
* Data
* Database
* Operations
* Troubleshooting

The system should determine how to handle the question.

Answers should match the depth implied by the question (short explanation,
detailed technical explanation, step-by-step workflow, or code-level detail)
rather than always returning maximum detail. Users may ask follow-ups for more
detail without restating full context.

---

# 47. QUESTION UNDERSTANDING

The system should first understand the user's question.

If enough information exists:

> Answer directly.

If information is genuinely missing:

> Ask clarification.

Do not ask unnecessary questions.

---

# 48. CLARIFICATION PRINCIPLE

Clarification should happen **only when required**.

Do not automatically show:

> Would you like more details?

or generic suggested questions after every response.

The system should ask the minimum number of clarification questions necessary.

---

# 49. CLARIFICATION LOCATION

Clarification questions must appear:

* Inside the active Chat
* Near the bottom
* Immediately after the latest assistant message
* Immediately above the composer

Do not open a modal or separate screen.

---

# 50. SEQUENTIAL CLARIFICATION

Multiple clarifications must appear **one at a time**.

Example:

```text
Assistant:

Which environment do you mean?

[Production]
[Staging]
[Development]
```

After answering:

```text
Assistant:

Which area should I analyze?

☐ Orders
☐ Payments
☐ Customers
```

Then:

```text
Assistant:

What specific customer segment are you referring to?

[Enter your answer...]
```

Only one clarification should be active at a time.

---

# 51. CLARIFICATION TYPES

Support:

### Single Select

Exactly one option.

### Multi Select

Multiple options.

### Free Text

User-provided answer.

Choose the interaction type based on the actual information required.

Do not force every clarification into predefined options.

---

# 52. CLARIFICATION STATE

Preserve:

* Original question
* Previous clarification questions
* User answers
* Current clarification

If the user navigates away and returns, preserve the state.

---

# 53. EDIT PREVIOUS USER MESSAGE

Users must be able to edit previous user messages.

Provide an unobtrusive:

> Edit

action.

The message should become an inline editable composer.

---

# 54. RESUBMIT EDITED MESSAGE

After editing:

[Submit]

The updated message must be resubmitted within the same conversation.

Do not force the user to create a new chat.

**This slice uses one thread:** later messages after the edited point are **replaced**.
The user must see that answers after that point will be discarded and regenerated.
Do not present a conversation-branch switcher.

---

# 55. MARKDOWN RESPONSES

Assistant responses will be returned as Markdown.

The UI must render Markdown properly.

Support:

* Headings
* Paragraphs
* Bold
* Italic
* Lists
* Nested lists
* Tables
* Links
* Blockquotes
* Inline code
* Fenced code blocks
* Horizontal separators

Never display raw Markdown syntax as the primary presentation.

---

# 56. CODE BLOCKS

Support:

* Syntax highlighting where available
* Language indicator where available
* Copy action
* Horizontal scrolling
* Mobile usability

Long code blocks must not break the layout.

---

# 57. TABLES

Markdown tables should render as proper tables.

On mobile, provide horizontal scrolling or another appropriate responsive interaction.

Do not make tables unreadably narrow.

---

# 58. STREAMING

If the underlying system supports streaming, the Chat UI must support incremental responses.

It should correctly handle:

* Partial text
* Partial Markdown
* Code blocks
* Tables
* Completion
* Errors
* Cancellation if supported
* Interruption / disconnect

Do not assume the response arrives as a single block.

### Stream interruption and chat state recovery

Distinguish:

* Generating
* Completed
* Failed
* Cancelled
* Interrupted

When the client reconnects after a disconnect, restore the conversation message
state from the backend. An interrupted partial response must not look like a
finished answer. Offer Retry where supported.

Never leave an indefinitely spinning “generating” state when the backend reports
interrupted, failed, cancelled, or completed.

---

# 59. THINKING / EXECUTION STATES

The UI should support meaningful AI/agent execution states when they are actually available.

Examples:

> Understanding question...

> Searching project knowledge...

> Reviewing relevant sources...

> Preparing response...

Later slice only (do not show in this slice):

> Generating database query...

> Validating query...

> Executing approved query...

These states must correspond to real underlying operations.

---

# 60. NO FAKE THINKING

Do not fabricate:

* Chain-of-thought
* Internal reasoning
* Fake thinking messages
* Fake tool calls
* Fake progress
* Fake token counts
* Fake context usage
* Fake completion states

The UI should display observable execution status only.

Do not expose private chain-of-thought.

---

# 61. RESPONSE METRICS

If reliable metrics are available, show them subtly.

Example:

> 2.8s · 4.8K tokens · 18.4K context

Possible metrics:

* Response time
* Tokens used
* Context consumed

If a metric is unavailable, omit it.

Never fabricate values.

---

# 62. STOP GENERATION

If the underlying system supports cancellation, provide:

> Stop

during generation.

After cancellation:

> Generation stopped

Do not display a Stop action if cancellation is not actually supported.

---

# 63. RESPONSE RETRY

When a response fails and retry is supported:

> We couldn't complete the response.

[Retry]

Preserve the original question.

---

# 64. RESPONSE ERRORS

Clearly distinguish between:

* Knowledge unavailable
* Source unavailable
* Question queued because knowledge is updating
* Response generation failure
* Insufficient information / abstain (not an error, but not a confident answer)
* Rate limited / temporarily throttled
* Query generation failure (later slice; not current)
* Query execution failure (later slice; not current)

Provide understandable messages and appropriate next actions.

Do not show raw internal errors as the primary UI.

When rate-limited, show that the action is temporarily limited, which action was
limited when known, and when retry is allowed if the backend provides that.

When a correlation / reference ID is present, display it for support.

---

# 64A. ABSTAIN / UNKNOWN ANSWERS

When the backend reports insufficient evidence, show an abstain / unknown answer
rather than a confident guess.

Example:

> The project does not currently contain enough information to answer this
> question confidently.

Where the backend identifies what is missing, show that clearly (for example
missing documentation, missing source areas, or incomplete knowledge).

Preserve useful next actions such as adding source, retrying after knowledge is
ready, or asking a narrower question.

Do not visually present abstain responses as successful grounded answers.

---

# 65. CONVERSATIONAL CONTEXT

Preserve context across:

* Follow-up questions
* Clarifications
* Edited messages
* Source exploration
* Knowledge exploration
* Database-query interactions (later slice; not current)

The user should not have to manually reconstruct context.

---

# 66. EVIDENCE / SOURCES

Important answers should provide supporting sources.

Example:

> Sources · 4

Users should be able to inspect:

* Source files
* Relevant code
* Documentation
* Project entities
* Supporting information

Evidence should not interrupt the conversation.

---

# 67. SOURCE PREVIEW

When a source is opened, show:

* File/document name
* Relevant location
* Relevant content
* Context
* Relationship to the answer

The user should be able to return to the exact conversation.

---

# 68. ASK ABOUT THIS

Provide contextual:

> Ask about this

actions for:

* Files
* Functions
* APIs
* Workflows
* Services
* Documentation
* Data entities
* Search results
* Knowledge items

It should activate the current Chat workspace and preserve the project context.

---

# 69. CHAT → KNOWLEDGE

If the user selects a source or project entity from an answer:

* Open the relevant project information
* Preserve the current conversation
* Allow return to the same conversation
* Do not create an unrelated chat

---

# 70. KNOWLEDGE → CHAT

From Knowledge Explorer, users should be able to:

> Ask about this

This should open/activate the project's embedded Chat workspace.

The relevant item should automatically become contextual information for the conversation.

---

# 71. KNOWLEDGE EXPLORER

Provide a dedicated Knowledge Explorer.

Example:

```text
Project
├── Capabilities
├── Workflows
├── Services
├── APIs
├── Components
├── Functions
├── Documentation
├── Data
└── Integrations
```

Show only items the backend actually provides for this slice. Live customer-database
entities under Data are later slice only.

Allow users to explore relationships.

Example:

> Checkout

↓

> Order Service

↓

> Payment Service

↓

> Payment Data

↓

> Source Code

The experience should feel like exploring a map of the software system.

---

# 72. SEARCH

Provide project-wide search.

Results should distinguish:

* Code
* Documentation
* Functionality
* Workflows
* APIs
* Data
* Other project knowledge

Actions:

* Open
* View details
* Ask about this

---

# 73. CHANGE SUMMARY

After project updates, provide meaningful change information.

Example:

```text
Project knowledge updated

24 files added
17 files modified
8 files removed

3 APIs changed
2 workflows changed
1 documentation conflict
```

Prioritize functional impact over raw file changes.

### Documentation vs code conflicts

When documentation and implementation disagree, present the discrepancy with
inspectable evidence for both sides. Do not silently prefer one side.

Example:

> Documentation says X, but the current implementation does Y.

Users must be able to open the related documentation and code evidence.

---

# 74. KNOWLEDGE HEALTH

Provide a simple knowledge-health view.

Example:

```text
Knowledge Health · Good

Source code        Good
Documentation      Good
Project knowledge  Good
Stale information  2 items
```

If files were excluded from the code map (for example larger than the indexer limit),
show **partial** knowledge and that Chat is answering from an incomplete map.

**Data knowledge** and customer-database health are later slice only — do not show them
as current capabilities.

Keep it simple.

Avoid overwhelming dashboards.

---

# 75. DATABASE QUERY EXPERIENCE

**Current product slice:** live extraction from a customer application database is
**out of scope**. This section and §§76–78 are future UI requirements. Do not show
query preview, approval, or result-from-database flows in this slice.

When that later slice is enabled, if a user asks a question requiring database
extraction, keep the experience within Chat.

Example:

> How many customers cancelled their orders last month?

Show:

### Interpretation

> Customers whose orders were marked cancelled during the previous calendar month.

### Data used

> Customers → Orders → Cancellation information

### Query

[Expand Query]

### Assumptions

> Cancellation date is based on the available cancellation field.

Then provide the appropriate execution/approval action.

---

# 76. QUERY APPROVAL

If approval is required:

> Query generated

> Approval required before execution.

Actions:

[Review Query]

[Request Approval]

Clearly communicate:

* What will happen
* Why approval is required
* Who needs to approve
* Current approval state

---

# 77. QUERY RESULTS

Present results in an understandable form.

Support:

* Summary
* Tables
* Key metrics
* Interpretation

Example:

> **1,842 customers**

[View Data]

Do not simply display raw database output without explanation.

---

# 78. ENVIRONMENT INDICATOR

When a project/environment distinction exists, make it clearly visible.

Example:

> Production

The user must never accidentally assume they are working with another environment.

---

# 79. CONVERSATION TITLES

Automatically generate meaningful conversation titles where possible.

Examples:

* Checkout flow
* Authentication implementation
* Payment failure investigation
* Customer cancellation analysis

Avoid:

> New Chat

when a useful title is available.

---

# 80. PROJECT CHAT PERSISTENCE

Chat should remain associated with the project.

Moving between:

> Project Overview → Chat → Knowledge → Chat

must preserve the active conversation.

The user should return to the same conversation.

Do not unexpectedly create a new chat.

---

# 81. PROJECT NAVIGATION

Within a project provide access to:

* Overview
* Chat
* Knowledge
* Search
* Changes
* Sources
* Health

Always make clear:

* Organization
* Project
* Current location

---

# 81A. PROJECT SOURCES

The Sources view must show the project’s connected and uploaded source material
using backend-provided information.

Show where available:

* Connected repository and selected branch
* Upload / source versions or processing events
* Origin (upload vs repository)
* Initiating user
* Timestamp
* Processing status and result
* Link to processing details, exclusions, and errors
* Credential / connection management actions where permitted (§14A)

Additional uploads must feel like updating existing project knowledge, not
creating a new project.

---

# 81B. PROJECT ARCHIVE AND DELETION

Authorized users must be able to archive or soft-delete a project according to
backend permissions and policy.

Before confirming, clearly explain what happens to:

* Source
* Knowledge
* Conversations
* Processing history
* Audit records (as the backend defines retention)

Archived / soft-deleted projects must not appear in normal project lists and must
not remain askable until restored (when restoration is supported).

Do not hard-delete from the primary product UI unless the backend exposes an
explicit purge path.

---

# 82. USER MANAGEMENT

Administration must provide user management.

Show:

* User
* Role
* Status
* Project access
* Last activity

Actions:

* Edit role
* Manage access
* Activate
* Deactivate
* Remove user where permitted (soft-remove / removal distinct from deactivate)
* Reset password

When removing a user, confirm the access consequences before proceeding.

---

# 83. ADMIN USER CREATION

Administrators must be able to create users.

The flow should be simple and clear.

Allow the administrator to:

* Enter user information
* Assign role
* Assign project access
* Create the user

Avoid unnecessary steps.

---

# 84. PASSWORD RESET

Administrators should be able to reset passwords for other users where permitted.

The action should clearly communicate:

* Which user is affected
* What will happen
* Whether the user will receive instructions
* Current reset status

---

# 85. ROLE AND PERMISSION UX

Permissions must be described in human-readable language.

Examples:

> Can view organization

> Can manage users and roles

> Can create projects

> Can view project knowledge

> Can upload project sources

> Can connect repositories

> Can trigger knowledge updates

> Can ask questions

> Can view and archive conversations

> Can search project knowledge

> Can generate database queries (later slice; not current)

> Can execute database queries (later slice; not current)

> Can manage project settings and users

> Can view usage

> Can view audit logs

Group permissions logically.

Do not expose internal permission identifiers.

Never rely on hiding a control alone for security — unauthorized actions must
still fail safely if attempted, with an understandable authorization message.

---

# 86. USAGE

Provide organization usage information where appropriate.

Show:

* Questions
* Token usage
* Context usage
* Knowledge processing
* Source ingestion volume where available
* Database queries (later slice; not current)
* Usage by project
* Usage by user

Only show metrics that are actually available. Never fabricate usage values.

---

# 86A. RETENTION SETTINGS

Where the backend exposes retention configuration to administrators, provide a
simple Retention settings experience for:

* Source
* Knowledge
* Conversations
* Audit logs
* Query history (later slice where applicable)
* Processing history

Explain retention effects in plain language.

If retention is not exposed by the backend as a product setting, do not invent
controls for it.

---

# 87. NOTIFICATIONS

Support important notifications:

* Knowledge update completed
* Knowledge update failed
* Repository update detected
* Processing requires attention
* Administrative events
* Approval requested (later slice; not current)
* Approval completed (later slice; not current)

Notifications should be actionable.

---

# 87A. AUDIT LOG UI

Administration must provide an Audit view for authorized users.

Show auditable events such as:

* User and role changes
* Project create / archive / delete
* Source upload and repository connection changes
* Knowledge processing triggers and outcomes
* Sensitive source access where the backend records it
* Other administrative actions

Each event detail should include, when provided by the backend:

* Actor
* Action
* Target resource
* Timestamp
* Result / outcome

Support list, filter, and detail inspection.

Never display secrets, credentials, or unnecessary sensitive payloads in audit
context.

---

# 88. EMPTY STATES

Every major screen must have a useful empty state.

Example:

### No Projects

> Create your first project to start understanding your software.

[Create Project]

### No Conversations

> Ask your first question about this project.

[Ask a Question]

### No Knowledge

> Add source code or connect a repository to build project knowledge.

[Add Source]

Avoid:

> No data found.

---

# 89. LOADING STATES

Every major screen must have intentional loading states.

Use:

* Skeletons
* Meaningful status
* Progress indicators

Avoid layout jumps.

---

# 90. ERROR STATES

Errors should be understandable and actionable.

Instead of:

> HTTP 500

show:

> **We couldn't update the project right now.**

> Asking questions is paused until the project map is ready again.

[Try Again]

Distinguish authorization failures, validation failures, temporary failures, and
rate limits from generic system failures when the backend provides that
distinction.

When a correlation / reference ID is available, show it.

---

# 91. RESPONSIVE DESIGN

Design intentionally for:

### Desktop

Maximum productivity and information density.

### Tablet

Balanced navigation and content.

### Mobile

Prioritize:

1. Chat
2. Search
3. Projects
4. Conversations
5. Project status
6. Essential administration

Do not simply shrink desktop screens.

---

# 92. MOBILE CHAT

On mobile, the desktop two-panel Chat layout should become a natural single-column experience.

Conversation history can be accessed through an appropriate mobile navigation pattern.

The active conversation remains the primary screen.

The user must be able to:

* Switch conversations
* Create new conversations
* Archive conversations
* Continue previous conversations
* Edit messages
* Answer clarification questions

without awkward interactions.

---

# 93. MOBILE PROJECT CONTEXT

Chat must still clearly indicate the current project.

The user should always know which project they are asking about.

---

# 94. ACCESSIBILITY

Support:

* Keyboard navigation
* Focus management
* Screen readers
* Appropriate contrast
* Accessible labels
* Accessible error messages
* Responsive text
* Reduced-motion preferences

Accessibility must be designed from the beginning.

---

# 95. MICRO-INTERACTIONS

Use subtle animation for:

* Navigation
* Progress
* Success
* Context changes
* Evidence expansion
* Source previews
* Knowledge updates
* Notifications
* Chat state transitions

Do not use animation purely for decoration.

---

# 96. INFORMATION DENSITY

The system may contain extremely complex information.

Do not expose everything simultaneously.

Use:

* Progressive disclosure
* Expandable sections
* Side panels
* Contextual details
* Drill-down views
* Appropriate tabs

The default experience should remain simple.

Advanced information should be accessible when needed.

---

# 97. TRUST AND TRANSPARENCY

Clearly distinguish:

* Known information
* Derived information
* Assumptions
* Missing information
* Conflicting information
* Warnings
* Abstain / insufficient evidence

Do not visually create false certainty.

Do not use meaningless confidence scores.

When information is stale after a source change, prefer the backend’s stale /
outdated indication over presenting known-outdated content as current.

---

# 98. TECHNICAL REALISM

Every visible UI state must correspond to a capability that the underlying product can actually provide.

Only display:

* Actual streaming
* Actual processing states
* Actual tool execution
* Actual source retrieval
* Actual response timing
* Actual token usage
* Actual context usage
* Actual cancellation
* Actual retry
* Actual query generation (later slice; not current)
* Actual query execution (later slice; not current)

Do not fabricate technical behavior for visual effect.

---

# 99. MINIMAL-CLICK DESIGN

The product must aggressively minimize unnecessary clicks.

Prefer:

> Click → useful result

over:

> Click → modal → configuration → next → confirm → processing → result

Additional steps should only exist when they provide real value, security, clarification, or authorization.

---

# 100. CONTEXTUAL ACTIONS

Actions should appear where they are relevant.

For a function:

> Ask about this

> View callers

> View documentation

For a workflow:

> Explore implementation

> Ask about this

For a data entity:

> Ask about this

> View related code

Do not force unnecessary navigation.

---

# 101. CHAT AS THE CENTRAL INVESTIGATION WORKSPACE

The product should treat Chat as the primary investigation workspace.

Users should be able to move naturally between:

```text
Project Overview
      ↓
Chat
      ↓
Question
      ↓
Clarification if necessary
      ↓
Answer
      ↓
Evidence
      ↓
Source / Knowledge
      ↓
Back to Chat
      ↓
Follow-up
```

The conversation should remain intact throughout the investigation.

---

# 102. CORE UX LOOP

The complete primary experience should be:

```text
Create Project
      ↓
Upload / Connect Repository
      ↓
Select Branch if Required
      ↓
Upload / Retrieve Project
      ↓
Understandable Processing
      ↓
Knowledge Ready
      ↓
Project Overview
      ↓
Embedded Chat Workspace
      ↓
Ask Anything
      ↓
Understand Question
      ↓
Clarify Only If Necessary
      ↓
Ask Clarification One at a Time
      ↓
Analyze
      ↓
Markdown Answer
      ↓
Evidence
      ↓
Explore Related Knowledge
      ↓
Return to Chat
      ↓
Continue Conversation
```

---

# 103. OVERALL PRODUCT STRUCTURE

The resulting product should conceptually look like:

```text
Organization
│
├── Sign-in / Session
│
├── Projects
│   │
│   └── Project
│       │
│       ├── Overview
│       │
│       ├── Chat
│       │   │
│       │   ├── Conversation History (private to owning user)
│       │   │   ├── Recent
│       │   │   └── Archived
│       │   │
│       │   └── Active Conversation
│       │
│       ├── Knowledge
│       │
│       ├── Search
│       │
│       ├── Changes
│       │
│       ├── Sources
│       │
│       └── Health
│
└── Administration
    ├── Users
    ├── Roles
    ├── Permissions
    ├── Projects
    ├── Retention
    ├── Usage
    └── Audit
```

---

# 104. FINAL UX OBJECTIVE

The final product should feel like:

> **An intelligent, persistent map of an organization's software systems that users can talk to.**

It should combine:

* Project understanding
* Code understanding
* Documentation understanding
* Business functionality understanding
* Knowledge exploration
* Conversational investigation
* Evidence
* Persistent conversations

into one coherent experience.

The user should be able to:

> **Upload a project → let the system understand it → ask any question → clarify only when necessary → receive a grounded Markdown answer → inspect evidence → explore the project → return to the same conversation → continue asking questions.**

The interface must be:

**Premium + Enterprise-grade + Minimal-click + Context-aware + Technically credible + Responsive + Mobile-friendly + Accessible + Intuitive.**

Most importantly:

> **The UI must make a highly complex software system feel simple without hiding important information.**

The product should absorb the complexity of the underlying software system, AI processing, knowledge creation, and source analysis so that the user experiences a simple, natural workflow. Live customer-data extraction is a later slice.

---

# 105. NON-NEGOTIABLE UX RULES

1. Chat is **not a popup**.
2. Chat is an **embedded project workspace**.
3. Conversation history is shown on the **left side of Chat on desktop**.
4. Users can return to and continue any previous conversation.
5. Conversations remain usable until the supported context capacity is reached.
6. Users can archive old conversations.
7. Users can restore archived conversations.
8. Users can edit previous user messages.
9. Edited messages can be resubmitted in the **same single thread**; later messages after that point are replaced and that must be visible.
10. Clarification questions appear **only when genuinely necessary**.
11. Clarifications appear **near the bottom of the active conversation**.
12. Multiple clarifications are asked **one at a time**.
13. Clarifications can be single-select, multi-select, or free text.
14. Assistant responses support Markdown.
15. Code blocks and tables must render correctly.
16. Streaming must be supported when actually available.
17. Thinking/activity states must represent actual observable system activity.
18. Fake thinking, fake progress, fake token counts, and fake tool execution must never be shown.
19. Response time, token usage, and context usage must only be shown when reliably available.
20. Processing failures must remain visible after navigation.
21. Processing failures must be understandable and retryable where possible.
22. GitHub/GitLab connection must probe the URL first, then collect a token only when authentication is required, then confirm branch before attach.
23. Repository authentication must show provider-specific inline token steps (GitHub, GitLab.com, self-hosted GitLab) plus a direct Open token page link.
24. Folder upload must be supported where possible.
25. ZIP must be supported as the fallback for folder upload.
26. Additional source uploads must update the existing project knowledge.
27. Project Overview → Chat must preserve the project context.
28. Chat → Knowledge → Chat must preserve the active conversation.
29. The UI must minimize unnecessary clicks.
30. The product must feel like one continuous project-understanding workspace rather than a collection of disconnected screens.
31. Sign-in / session expiry must gate protected content; do not show project data while signed out.
32. Insufficient-evidence answers must abstain clearly; never present invented project behavior as fact.
33. Interrupted or disconnected streams must not look complete and must not spin forever.
34. Conversations are private to the owning user unless the backend explicitly supports sharing.
35. Secrets and credentials must never be redisplayed from API responses, errors, audit, or chat.
36. Project archive / soft-delete must explain consequences and hide archived projects from normal use.
37. Audit, usage, and retention admin surfaces must only show backend-provided data — never fabricate metrics or events.
38. Rate limits and support correlation IDs must be shown when the backend provides them.

---

# 106. CONVERSATION PRIVACY

Multiple users may use the same project at the same time.

Project knowledge is shared according to project permissions.

Each user’s conversations and conversational context remain private to that user
unless the backend later adds an explicit share feature.

The UI must not imply that teammates can see another user’s chat history by
default.

A conversation must not silently become project knowledge.

---

# 107. SECRET PROTECTION IN THE UI

The UI must never render:

* Repository credentials
* Database credentials (later slice)
* Authentication secrets
* Other sensitive configuration secrets

from API responses, error payloads, audit records, notifications, or chat
answers.

Credential entry fields are write-only after save (masked or empty on reload).

---

# 108. STALE KNOWLEDGE PRESENTATION

If relevant knowledge is outdated after a source change, prefer the backend’s
stale / outdated indication.

Do not present known-outdated information as current when the backend marks it
stale.

Where answers include knowledge-version metadata, show it subtly for
traceability.
