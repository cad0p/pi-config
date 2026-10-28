import type { VaultTemplate } from "./types.js";

export const product: VaultTemplate = {
  name: "product",
  description: "Product development and management",
  dirs: ["features", "roadmap", "research", "specs", "releases", "daily"],
  files: {
    "features/_about.md": `# Features

One note per feature. Include status, owner, and user-facing description.
`,
    "roadmap/_about.md": `# Roadmap

Planning docs, quarterly goals, and prioritization.
`,
    "research/_about.md": `# Research

User research, competitor analysis, market insights.
`,
    "specs/_about.md": `# Specs

Product specs and requirements. Link to related features.
`,
    "releases/_about.md": `# Releases

Release notes, rollout plans, and post-mortems.
`,
    "Templates/Feature.md": `---
status: proposed
owner: ""
priority: ""
---
# {{title}}

## User story
As a ___, I want ___ so that ___.

## Requirements
- 

## Design
- 

## Open questions
- 
`,
    "Templates/Spec.md": `---
status: draft
date: "{{date}}"
owner: ""
---
# {{title}}

## Overview
What is this spec for?

## Requirements
### Must have
- 

### Nice to have
- 

## Technical notes
- 

## Dependencies
- 
`,
    "Templates/Release.md": `---
version: ""
date: "{{date}}"
---
# {{title}}

## What's new
- 

## Breaking changes
- 

## Migration guide
- 

## Rollout plan
1. 
`,
    "Templates/Research.md": `---
type: ""
date: "{{date}}"
---
# {{title}}

## Objective
What are we trying to learn?

## Methodology
- 

## Findings
- 

## Recommendations
- 
`,
  },
  napkinMd: `# Product name

## What is this product?
Brief description and value proposition.

## Users
- Target audience:
- Key personas:

## Current priorities
- 

## Metrics
- 

## Roadmap
- 
`,
};
