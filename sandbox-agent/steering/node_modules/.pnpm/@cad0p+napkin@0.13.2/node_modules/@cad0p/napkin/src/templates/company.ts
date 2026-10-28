import type { VaultTemplate } from "./types.js";

export const company: VaultTemplate = {
  name: "company",
  description: "Team and organization knowledge base",
  dirs: [
    "people",
    "projects",
    "runbooks",
    "infrastructure",
    "onboarding",
    "daily",
  ],
  files: {
    "people/_about.md": `# People

Team members, roles, and ownership. One note per person.
`,
    "projects/_about.md": `# Projects

Active projects and initiatives. Archive completed ones.
`,
    "runbooks/_about.md": `# Runbooks

Operational procedures. Step-by-step guides for recurring tasks.
`,
    "infrastructure/_about.md": `# Infrastructure

Tools, services, repositories, and how they connect.
`,
    "onboarding/_about.md": `# Onboarding

Getting new team members and agents up to speed.
`,
    "Templates/Person.md": `---
role: ""
team: ""
owner: ""
---
# {{title}}

## Role
What does this person do?

## Responsibilities
- 

## Contact
- 
`,
    "Templates/Runbook.md": `---
owner: ""
last_verified: "{{date}}"
---
# {{title}}

## Goal
What does this runbook accomplish?

## Steps
1. 

## Verification
- [ ] How to confirm it worked

## Troubleshooting
- 
`,
    "Templates/Project.md": `---
status: active
owner: ""
started: "{{date}}"
---
# {{title}}

## Objective
What are we trying to achieve?

## Key results
- [ ] 

## Team
- 

## Notes
- 
`,
    "Templates/Onboarding.md": `---
role: ""
date: "{{date}}"
---
# Onboarding — {{title}}

## Checklist
- [ ] Access granted
- [ ] Tools set up
- [ ] Key docs reviewed
- [ ] First task assigned

## Notes
- 
`,
  },
  napkinMd: `# Company name

## What do we do?
Brief description.

## Team
- 

## Communication
- Primary channel:
- Task tracking:
- Documentation:

## Key tools & services
- 

## Active projects
- 
`,
};
