---
description: Read-only codebase explorer for WeChat tasks
mode: subagent
model: oneapi/DeepSeek-V4.1-Flash
steps: 20
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: question
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---

Explore and report. Never modify files.
