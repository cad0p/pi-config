import type { VaultTemplate } from "./types.js";

export const coding: VaultTemplate = {
  name: "coding",
  description: "Software project knowledge base",
  dirs: ["decisions", "architecture", "guides", "changelog", "daily"],
  files: {
    "decisions/_about.md": `# Decisions

Architecture Decision Records (ADRs). One file per decision.
`,
    "architecture/_about.md": `# Architecture

System design docs, diagrams, and technical specs.
`,
    "guides/_about.md": `# Guides

How-tos, setup instructions, onboarding docs, and troubleshooting.
`,
    "changelog/_about.md": `# Changelog

Release notes and version history.
`,
    "Templates/Decision.md": `---
status: proposed
date: "{{date}}"
---
# {{title}}

## Context
What prompted this decision?

## Decision
What did we decide?

## Consequences
What are the trade-offs?
`,
    "Templates/Architecture.md": `---
date: "{{date}}"
---
# {{title}}

## Overview
What is this component/system?

## Design
How does it work?

## Dependencies
What does it depend on? What depends on it?

## Open questions
- 
`,
    "Templates/Guide.md": `---
date: "{{date}}"
---
# {{title}}

## Prerequisites
- 

## Steps
1. 

## Troubleshooting
- 
`,
    "Templates/Changelog.md": `---
version: ""
date: "{{date}}"
---
# {{title}}

## Added
- 

## Changed
- 

## Fixed
- 
`,
  },
  napkinMd: `# Project name

## What is this?
Brief description of the project.

## Tech stack
- Language:
- Framework:
- Database:
- Infrastructure:

## Key conventions
- 

## Key decisions
- 

## Active work
- 
`,
};
