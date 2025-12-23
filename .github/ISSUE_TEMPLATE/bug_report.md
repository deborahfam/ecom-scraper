---
name: Bug report
about: Create a report to help us improve. Please review Troubleshooting steps before you submit a bug.
title: 'BUG: '
labels: 'bug'
assignees: ''
body:
- type: checkboxes
  attributes:
    label: Troubleshooting
    description: Please review troubleshooting steps before opening an issue.
    options:
      - label: I have reviewed the troubleshooting instructions
        required: true
- type: input
  attributes:
    label: Operating System
    description: What operating system are you using?
    value: operating system
  validations:
    required: true
- type: input
  attributes:
    label: Browser
  validations:
    required: true

---

IMPORTANT: If your issue is related to missing content on page, please review the troubleshooting instructions.

**Version (please complete the following information):**

- OS: [e.g. Windows]
- Browser [e.g. Chrome, Firefox]
- Extension version: [e.g. 0.12.0]

**Describe the bug**

A clear and concise description of the bug. If applicable, add screenshots to help explain the problem.

**Expected behavior**

What did you expect to happen?

**URLs where the bug occurs**

Any specific web pages where the bug can be replicated.

**To reproduce**

Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Your template file**

If you are using a custom template (i.e. not the Default template). Go to Web Clipper settings and click **More** → **Copy as JSON**. Paste the JSON code below.

```json
(paste here)
```
