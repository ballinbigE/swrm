# Swrm — architecture (living doc)

> Refreshed as the system is built. The rendered snapshot lives at
> `assets/architecture.svg`; this Mermaid source is canonical.

**Core decision:** the **git repo of Markdown stories is the only shared
contract.** Every surface is a renderer over the same `front-matter + body`
schema. No cross-language core bridge — native is Swift, web is the existing
Node app, unified only by the file format and git.

```mermaid
flowchart TD
  subgraph Surfaces
    macOS["macOS app (SwiftUI)"]
    iOS["iOS app (SwiftUI)"]
    Web["localhost / web view"]
  end

  subgraph Cores
    CoreSwift["SwrmCore — Swift (SwiftPM)\nparse · index · board · git"]
    CoreTS["swrm-web — Node / TS (existing)\nparse · index · board"]
  end

  macOS --> CoreSwift
  iOS --> CoreSwift
  Web --> CoreTS

  SOT[".swrm/stories/*.md\nYAML front-matter + body\n(git = database + audit log)"]
  CoreSwift <--> SOT
  CoreTS <--> SOT

  Providers["Provider layer — GitHub · GitLab\nauth · issues · commit · push · deploy"]
  CI["CI overlay\nis HEAD green? (live, not stored)"]
  Tokens["Secure tokens\nKeychain (Apple) / encrypted (web)"]

  CoreSwift <--> Providers
  CoreTS <--> Providers
  Providers --> CI
  Providers -.->|never committed| Tokens
```

## Story schema (the contract)
```
.swrm/stories/sc-42.md
---
id: sc-42
type: feature        # feature | bug | chore
state: started       # backlog | unstarted | started | done   (the 4 Shortcut state types)
epic: onboarding
labels: [ios, p1]
rank: "0|hzzzzz:"    # lexorank — column ordering
---
Wire up the login screen.
- [ ] form
- [ ] validation
```
- Board column = the `state` type. Moving a card = one front-matter field edit = one clean git commit.
- CI status is an **overlay** fetched live per HEAD — never written into Markdown.
- Branch convention `sc-<id>/slug`; PR merge → `state: done` (suppressed if other open PRs).
