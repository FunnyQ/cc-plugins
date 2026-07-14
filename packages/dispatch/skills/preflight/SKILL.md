---
name: preflight
version: 0.1.0
description: Interactive interviewer that gathers requirements through systematic questioning. AUTO-TRIGGER when (1) user's request is vague or ambiguous and needs clarification, (2) user explicitly asks to "dig deeper", "ask me questions", "interview me", or "help me think through this", (3) user wants to build a spec, PRD, or outline before implementation, (4) user says "I have an idea but not sure about details". Supports project specs, feature requirements, and writing outlines. Do NOT trigger when the user gives a clear, actionable instruction that can be executed directly.
argument-hint: "[topic]"
---

# Preflight

## Why Plan Mode and AskUserQuestion Matter

Preflight's entire value comes from two things:

1. **Plan mode** — The interview output is written to the plan file, giving the user a single document to approve or reject. Without plan mode, there's no approval gate and no structured output — the interview results scatter across chat history and lose their value.

2. **AskUserQuestion tool** — This tool provides structured options and keeps the conversation interactive. Plain text questions get buried in output and miss the structured response format. Every question you ask during the interview must go through `AskUserQuestion`.

If you skip either of these, the skill produces no useful artifact and the user gets a worse experience than just chatting normally.

**Wrong — plain text question, no plan mode:**
```
User: /preflight dark mode
Claude: "Great! Let me ask you some questions. What platforms do you need?"
```

**Right — plan mode first, then structured questions:**
```
User: /preflight dark mode
Claude: [calls EnterPlanMode]
        [calls AskUserQuestion with structured options]
```

## Process

### Step 1: Enter Plan Mode

Call `EnterPlanMode` immediately — before any text output, before any questions. If already in plan mode, skip this step. Everything that follows depends on having a plan file to write to.

### Step 2: Interview

Ask 1-2 questions per turn using `AskUserQuestion`. Follow the interview guide below based on the topic type.

**When to stop:** End the interview when you have enough context to write actionable acceptance criteria for each requirement. This typically takes 2-4 rounds. Signs you're ready:
- You understand the problem and who it's for
- You know the core requirements and can distinguish MVP from nice-to-have
- You've identified key constraints (tech, timeline, scope)
- Edge cases are at least acknowledged, even if not fully resolved

Don't over-interview — if the user gives comprehensive answers, 2 rounds may be enough. If answers are terse or raise new questions, go up to 4-5 rounds.

### Step 3: Write Plan

Write the spec and implementation plan to the plan file using the template below. Tailor the depth to the topic — a small feature needs a lighter plan than a new project.

### Step 4: Exit Plan Mode

Call `ExitPlanMode` so the user can review and approve. Wait for their response.

### Step 5: Execute

After approval, implement the plan. For larger plans:
- Work in logical stages (e.g., data model → API → UI)
- Remind the user to commit after each meaningful stage
- If the plan spans multiple files or systems, confirm the order of operations before starting

## Interview Guide

### Project (new system or app)

Focus on scoping a buildable MVP:

1. **Problem & users** — What problem are you solving? Who is it for?
2. **Core features** — What are the must-haves for v1? What can wait?
3. **Tech constraints** — Existing stack? Deployment target? Third-party integrations?
4. **Success metrics** — How will you know it's working?

### Feature (addition to existing system)

Focus on precise behavior definition:

1. **User story** — Who needs this and why?
2. **Current vs desired** — What happens now? What should happen instead?
3. **Acceptance criteria** — How do we verify it works? What are the edge cases?
4. **Scope boundary** — What's explicitly NOT included?

### Writing (spec, outline, documentation)

Focus on audience and structure:

1. **Audience & purpose** — Who reads this? What should they take away?
2. **Key message** — What's the one thing this must communicate?
3. **Tone & format** — Formal/casual? Length constraints? Required sections?
4. **Structure** — Chronological? Problem-solution? Reference-style?

## Plan File Template

```markdown
# <Topic>

## Overview
[1-2 sentence summary of what we're building/writing and why]

## Context
[Problem being solved, current situation]

## Requirements
[Structured list from interview — mark MVP vs later if applicable]

## Constraints
[Technical limitations, timeline, scope boundaries]

## Implementation Plan
[Step-by-step plan with enough detail to execute — file names, key decisions, order of operations]

## Open Questions
[Unknowns that surfaced during interview, if any — omit this section if none]
```

Adapt the template to fit the topic. A small feature might skip "Open Questions". A writing task might replace "Implementation Plan" with "Outline". Don't force every section if it doesn't add value.

## Examples

### Feature Request

```
User: /preflight dark mode toggle

Claude: [calls EnterPlanMode]
        [calls AskUserQuestion: "Where should the toggle live — settings page, navbar, or system preference auto-detect? And is this web only or also mobile?"]
User: Settings page, web only

Claude: [calls AskUserQuestion: "Should the preference persist across devices (needs backend) or is local storage fine? And do you have an existing design system or CSS framework?"]
User: Local storage fine, we use Tailwind

Claude: [writes plan to plan file with spec + implementation steps]
        [calls ExitPlanMode]
User: [approves plan]

Claude: [implements the plan]
```

### New Project

```
User: I want to build a CLI tool for managing dotfiles, but I'm not sure about the details

Claude: [calls EnterPlanMode]
        [calls AskUserQuestion: "What's your main pain point with dotfiles today — syncing across machines, version control, or setting up new machines quickly? And is this for personal use or something you'd share?"]
User: Mainly syncing between my Mac and Linux server. Personal use but might open source later.

Claude: [calls AskUserQuestion: "What dotfiles do you need to manage — shell configs, git, editor settings, others? And do you have a preferred approach — symlinks, templates, or just copy?"]
User: Shell, git, and neovim configs. Symlinks feel cleanest.

Claude: [calls AskUserQuestion: "Any must-haves for v1 beyond basic symlink management? Like conflict detection, backup before overwrite, or a dry-run mode?"]
User: Dry-run would be great. Backup not needed since everything's in git.

Claude: [writes plan with MVP scope: symlink manager + dry-run + git-based sync]
        [calls ExitPlanMode]
```
