# lessons — patterns learned from user corrections

Format: one entry per correction. Rule, then why, then how to apply.

## Standing preferences
- **Always visualize the architecture as it's built.** Keep a current diagram
  (diagram-as-code + rendered) and refresh it at each architectural change, not
  just at the end. Source: user, this session.
- **KAIZEN — ship small, verified increments.** Continuous improvement over big
  bangs. Break large directives into the smallest shippable, visible improvement;
  verify; capture the lesson; iterate. Don't batch risky work. Source: user, this
  session ("KAIZEN").
- **Don't rewrite/force-push history while the remote is actively changing.**
  Commits landed externally mid-session; a force-push would clobber in-flight
  work. Confirm the remote is quiet before any history rewrite. Source: observed
  this session.

## Corrections
_(append as they happen)_
