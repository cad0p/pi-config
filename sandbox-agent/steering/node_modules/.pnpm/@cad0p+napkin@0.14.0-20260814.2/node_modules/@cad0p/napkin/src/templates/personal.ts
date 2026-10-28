import type { VaultTemplate } from "./types.js";

export const personal: VaultTemplate = {
  name: "personal",
  description: "Personal assistant / life management",
  dirs: ["people", "projects", "areas", "daily", "references"],
  files: {
    "people/_about.md": `# People

One note per person. Include context the agent needs — role, relationship, preferences, last interaction.
`,
    "projects/_about.md": `# Projects

Active projects. Move completed ones to an archive/ subfolder.
`,
    "areas/_about.md": `# Areas

Ongoing life areas — health, finance, career, home, etc. Unlike projects, these don't end.
`,
    "references/_about.md": `# References

Articles, book notes, recipes, how-tos. Anything you want to find later.
`,
    "Templates/Person.md": `---
role: ""
relationship: ""
last_contact: "{{date}}"
---
# {{title}}

## Context
Who is this person and how do I know them?

## Notes
- 
`,
    "Templates/Project.md": `---
status: active
started: "{{date}}"
---
# {{title}}

## Goal
What's the outcome?

## Tasks
- [ ] 

## Notes
- 
`,
    "Templates/Area.md": `---
date: "{{date}}"
---
# {{title}}

## Current state
Where am I with this?

## Goals
- 

## Actions
- [ ] 
`,
    "Templates/Daily Note.md": `# {{date}}

## Today
- 

## Tasks
- [ ] 

## Notes
- 
`,
  },
  napkinMd: `# About me

## Who am I?
Name, role, context the agent needs.

## Current priorities
- 

## Preferences
- Communication style:
- Scheduling:

## Key people
- 
`,
};
