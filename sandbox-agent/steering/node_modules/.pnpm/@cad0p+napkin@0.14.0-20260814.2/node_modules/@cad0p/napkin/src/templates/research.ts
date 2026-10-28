import type { VaultTemplate } from "./types.js";

export const research: VaultTemplate = {
  name: "research",
  description: "Research and knowledge work",
  dirs: ["papers", "concepts", "questions", "experiments", "daily"],
  files: {
    "papers/_about.md": `# Papers

One note per paper. Include citation, key findings, and your commentary.
`,
    "concepts/_about.md": `# Concepts

Key ideas and definitions. Link heavily between concepts.
`,
    "questions/_about.md": `# Questions

Open research questions. Mark as resolved when answered, link to the answer.
`,
    "experiments/_about.md": `# Experiments

Results, logs, and methodology notes. One file per experiment or trial.
`,
    "Templates/Paper.md": `---
authors: []
year: ""
source: ""
tags: []
---
# {{title}}

## Summary
What is this paper about?

## Key findings
- 

## Methodology
- 

## My commentary
- 

## Related
- 
`,
    "Templates/Concept.md": `---
aliases: []
tags: []
---
# {{title}}

## Definition
What is this concept?

## Key points
- 

## Related concepts
- 
`,
    "Templates/Question.md": `---
status: open
date: "{{date}}"
---
# {{title}}

## Question
What exactly am I trying to answer?

## Context
Why does this matter?

## Progress
- 

## Answer
(fill when resolved)
`,
    "Templates/Experiment.md": `---
date: "{{date}}"
status: in-progress
---
# {{title}}

## Hypothesis
What do I expect to happen?

## Setup
- 

## Results
- 

## Conclusions
- 
`,
  },
  napkinMd: `# Research area

## Focus
What are you studying?

## Key questions
- 

## Methodology
- 

## Current reading
- 

## Open threads
- 
`,
};
