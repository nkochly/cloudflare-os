# Glossary

The words for this repo's domain. Read it before any task. The shared core
below is copied byte for byte from `wiki_mcp/GLOSSARY.md`, the Trifecta
master, and `scripts/check-glossary.mjs` holds it there; never edit it here.
The Context section after it is this repo's own: a new domain word for this
repo goes there, in the pull request that introduces it.

<!-- glossary-core:start -->
## Shared core

The Trifecta is several repos that run as one system: wiki_mcp, Muster,
microsite-kit, Executor, activity, wallflower, artifacts-quick, always-on-agent,
Cloudflare OS, and the CI repos. This core is the same, byte for byte, in every
repo's `GLOSSARY.md`. Its one source is `wiki_mcp/GLOSSARY.md`; change it there
and run `npm run glossary:sync` in wiki_mcp, which writes every copy and the
digest each repo's check holds it to. Never edit the core in a copy.

How to use this file:

- Use the term this file defines for every concept it defines, in code,
  comments, commit messages, docs, tool descriptions and replies. No synonyms.
- A new domain word goes into the glossary in the same pull request that
  introduces it: a shared word into the core (in wiki_mcp), a local word into
  this repo's own Context section below the core.
- A word may mean something narrower inside a Context section, never
  something different from the core.
- Renaming a database column, an API field or a tool name needs Nathan's
  explicit approval first. The "Code" lines below list every name a concept
  has today, so a mismatch is recorded, not hidden.
- Forks (Executor, wallflower, artifacts-quick, Cloudflare OS) keep their
  upstream names in code; their Context sections map them to these terms.

Each entry gives the definition, what it is not, and the code that implements
it with every name it has today.

### Who and which team

- **tenant**: One team: an account manager and their extended team. Its slug
  is owned by wiki_mcp and is the same in every service. Say "team" where
  people read, "tenant" in code.
  *Not:* an organization, a Studio workspace, or an Access group.
  *Code:* wiki_mcp `src/control/d1.ts`, `src/federation/tenants.ts`; Muster
  `apps/muster/src/tenants.ts`; Executor `organizationId`.
- **member**: A person in a tenant, with the role `owner`, `admin` or
  `member`. Membership gives administrative rights, never read access.
  *Not:* a grant.
  *Code:* wiki_mcp `membership`; Muster `tenants.ts` role enum; Executor
  directory role.
- **operator**: A platform admin of every Trifecta service.
  *Not:* a tenant owner or admin.
  *Code:* `OPERATOR_EMAILS`; `GET /api/directory/operators/:subject`.
- **person**: A human behind a call, signed in with Webex through Cloudflare
  Access.
  *Not:* a subject string, or an agent.
  *Code:* `via.person`; Muster principal for people.
- **agent**: Software acting for a tenant or a person, signed in with a
  service token.
  *Not:* a person, or a connector.
  *Code:* `svc:<name>`; `via.agent`.
- **subject**: The identity string Cloudflare Access gives a caller: an email
  or `svc:<name>`.
  *Not:* a principal (in Muster a principal is a subject plus its
  capabilities).
  *Code:* wiki_mcp `src/worker/identity.ts`; Muster
  `apps/muster/src/auth/access.ts` (`principal`).
- **grant**: Permission for a subject or a group on one wiki or one Muster
  project. The only thing that makes either readable.
  *Not:* tenant membership.
  *Code:* wiki_mcp `wiki_grant` (`reader`, `maintainer`); Muster grants and
  capabilities.
- **customer account**: One customer the team sells to, named by one
  kebab-case slug.
  *Not:* a sign-in, a connection, or a Cloudflare account.
  *Code:* wiki_mcp `src/okf/accounts.ts`, `list_accounts`, top-level folder
  `{account}/`; microsite-kit `customer` (`control/src/customers.ts`).
- **attribution**: The stamp of client, person, agent and guide that
  Executor puts on every call. A label beside the authenticated author, never
  used for access.
  *Not:* identity, or a permission.
  *Code:* request `_meta` key `dev.presidio-west/attribution`; wiki_mcp and
  Muster `src/attribution.ts`; stored as `via`.

### Tools and connections (Executor)

Executor is a fork whose own `GLOSSARY.md` carries only its upstream words.
These are the Trifecta's names for what agents meet through it.

- **app**: A package of tools Executor hosts, reached as `tools.<slug>.*`,
  such as `wiki-{TENANT}`.
  *Not:* a connector, or an Access application.
  *Code:* Executor v2 apps; v1 `integration`.
- **connection**: One signed-in link from Executor to an outside service. A
  team connection is shared by a tenant; a personal connection belongs to one
  person.
  *Not:* a customer account.
  *Code:* Executor `packages/core/sdk/src/connection.ts`; `accountId` on app
  calls; "workspace connection" means team connection.
- **toolkit**: A named subset of tools for one connection. It narrows, never
  widens.
  *Not:* an app.
  *Code:* Executor `packages/plugins/toolkits`.
- **connector**: The entry in Claude or AI Studio that points at an MCP
  server such as Executor.
  *Not:* an app, or a connection.
  *Code:* Studio and Claude settings.
- **guide**: How to use one server's tools, served by that server as a skill.
  *Not:* the team's playbook page, or a Garden skill.
  *Code:* the `guides` tool in wiki_mcp and Muster;
  `skill://wiki/<name>/SKILL.md`.

### Decision models

- **decision model**: An AI model that answers typed questions about some
  text with a probability for each allowed answer, and writes no text. Jev
  (TypeSafe) is one, reached through the AI Gateway that holds its key.
  *Not:* a language model, a rule, or a person's approval.
  *Code:* wiki_mcp `src/judgment/jev.ts` (`askJev`, `JEV_VERSION`), mirrored
  in Muster `packages/judgment`; always-on-agent `src/agent/jev.ts`;
  microsite-kit `control/src/policy.ts`; Cloudflare OS
  `DecisionModelBinding`.
- **judgment**: One named question a service asks a decision model, with the
  threshold it acts at and what happens when there is no answer. A judgment
  may warn, rank, sort or make a rule stricter; it never opens a gate, sets a
  status or replaces a person's approval. Each answer is one entry in that
  service's judgment log.
  *Not:* a decision (the model judges; a person or a rule decides), a
  finding, a diagnostic, or an approval.
  *Code:* `JudgmentRecord`; wiki_mcp `src/judgment/note-orders.ts`
  (`note_gives_orders`) and `src/links/suggest.ts`; Muster
  `apps/muster/src/judgment/` and `judgment_log`, `apps/feedback/src/sort.ts`
  (`sort_feedback`). always-on-agent calls these "Jev checks", microsite-kit
  "findings".

### Bounded contexts

Each repo owns the words for its own job. The shared core above is owned by
wiki_mcp, which owns tenants.

| Context | Repo | Words it owns |
| --- | --- | --- |
| Shared core | wiki_mcp, used by all | tenant, member, operator, person, agent, subject, grant, customer account, attribution |
| Work | Muster | project, task, status, pause, hold, task claim, review, finding, phase |
| Knowledge | wiki_mcp | wiki, note, page, source, cited claim, proposal, promotion, drift, type, vocabulary |
| Tools and connections | Executor | app, connection, toolkit, connector, policy, integration, secret |
| Customer sites | microsite-kit | site, door, publish, approval, invite, invitee, design |
| Boards | wallflower | board, card, group, frame, presenter |
| Shared documents | artifacts-quick | document, link, seal |
| Activity | activity | change, change log, feed |
| Lab: one person's agent | always-on-agent | channel, schedule, to-do, workspace folder, memory |
| Lab: interactive apps | Cloudflare OS | workspace, gadget, blueprint |
| CI and look | cf-github-runners, gh-ci-templates, presidio-ui | runner, approval, stage, token |

"Claim" is two things on purpose: a Muster lease and a wiki statement. Always
qualify it: **task claim** or **cited claim**.

### Words to avoid everywhere

- "organization" or "org": say tenant.
- "account" alone: say customer account, connection, or Cloudflare account.
- "workspace" alone: say Studio workspace, Cloudflare OS workspace, or
  workspace folder.
- "artifact" alone: say Claude page, artifacts-quick document, or Executor
  artifact.
- "board" for Muster: a view of tasks by status is a status view.
- wiki_mcp's retired words for work: item, agenda, hold (in the wiki), take,
  settle, drop, triage. Work and its words are Muster's.
<!-- glossary-core:end -->

## Context: Lab, interactive apps (Cloudflare OS)

This repo is a fork, deployed as built; its code keeps upstream's words. Lab
code: core never depends on it.

- **workspace**: One user's space for gadgets. Always say "Cloudflare OS
  workspace" outside this repo.
  *Not:* a tenant, a Studio workspace, or always-on-agent's workspace folder.
  *Code:* `packages/workshop-backend`.
- **gadget**: An app a person makes for themselves, run in the sandbox.
  *Not:* an Executor app.
  *Code:* `packages/workshop-backend`, `packages/workshop-frontend`.
- **blueprint**: A published template a gadget is made from; bundled
  blueprints ship with every deployment.
  *Not:* a microsite design.
  *Code:* `packages/bundled-blueprints`, `docs/blueprints.md`.
- **gatekeeper**: A Worker that gives gadgets sandboxed access to one outside
  service.
  *Not:* an Executor connection, which is the Trifecta's one way to outside
  tools.
  *Code:* `packages/gatekeeper-*`.
