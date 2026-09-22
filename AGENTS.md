# AGENTS.md
# Coding Standards & AI Agent Rules  
**Vertical Appointment Scheduling AI Agent**

> Version: 1.0  
> Last Updated: September 2026  
> Applies to: All humans and AI coding agents working on this repository.

---

## 1. Purpose

These rules exist to ensure the codebase remains:

- **Readable** — easy to understand by any engineer
- **Scalable** — can grow from MVP to multi-tenant, multi-channel, multi-vertical SaaS
- **Maintainable** — low cost of change over time
- **Consistent** — AI agents and humans produce the same quality of code

All AI coding agents (Cursor, Claude, Windsurf, Copilot, etc.) **must** follow these rules strictly.

---

## 2. Language Policy

| Context                        | Language     | Rule |
|--------------------------------|--------------|------|
| Code (variables, functions, classes, files, folders) | English | Mandatory |
| Comments & Docstrings          | English      | Mandatory |
| Commit messages                | English      | Mandatory |
| Internal documentation (`docs/`) | English    | Strongly preferred |
| User-facing text (WhatsApp, UI, SMS, email) | English | Mandatory |
| Logging messages               | English      | Mandatory |

**Never mix Indonesian and English inside the same function, class, or file.**

---

## 3. Core Engineering Principles

1. **Readability over cleverness**  
   Code is read far more often than it is written. Optimize for the next reader.

2. **Explicit is better than implicit**  
   Prefer clear and descriptive names. Avoid hidden magic.

3. **Small and focused units**  
   Every function and class should do one thing well.

4. **Fail fast and loud**  
   Validate inputs early. Raise meaningful errors instead of failing silently.

5. **Design for change**  
   Assume requirements will evolve. Prefer composition over deep inheritance hierarchies.

6. **No premature abstraction**  
   Do not create interfaces, base classes, or complex patterns until there are at least 2–3 real use cases.

7. **Minimize cognitive load**  
   A new engineer should be able to understand a module in under 15 minutes.

---

## 4. Naming Conventions

| Element              | Convention             | Good Example                     | Bad Example              |
|----------------------|------------------------|----------------------------------|--------------------------|
| Variables            | `snake_case`           | `appointment_id`, `is_confirmed` | `apptId`, `flag`         |
| Functions / Methods  | `snake_case`           | `create_appointment()`           | `createAppt()`           |
| Classes              | `PascalCase`           | `AppointmentService`             | `appointment_service`    |
| Constants            | `UPPER_SNAKE_CASE`     | `MAX_RETRY_ATTEMPTS`             | `maxRetry`               |
| Files                | `snake_case`           | `appointment_service.py`         | `AppointmentService.py`  |
| React Components     | `PascalCase`           | `AppointmentCard.tsx`            | `appointmentCard.tsx`    |
| Boolean variables    | Prefix with `is_`, `has_`, `can_`, `should_` | `is_active`, `can_reschedule` | `active`, `reschedule` |

**Rules:**
- Names must reveal intent.
- Avoid abbreviations unless they are extremely common and unambiguous (`id`, `url`, `http`, `api`).
- Do not use single-letter variable names except in very short loops (`i`, `j`).

---

## 5. Functions & Methods

### Rules
- Keep functions short (ideally under 40 lines).
- One level of abstraction per function.
- Prefer early returns over deep nesting.
- Always use type hints (Python) or proper TypeScript types.
- Public functions **must** have a complete docstring.
- Limit the number of parameters (prefer 3 or fewer). Use a data class or typed dict when needed.

### Docstring Standard (Google Style)

```python
def reschedule_appointment(
    appointment_id: str,
    new_slot: datetime,
    reason: str | None = None,
) -> Appointment:
    """
    Reschedule an existing appointment to a new time slot.

    Args:
        appointment_id: Unique identifier of the appointment.
        new_slot: The desired new datetime for the appointment.
        reason: Optional reason provided by the user for rescheduling.

    Returns:
        The updated Appointment object.

    Raises:
        AppointmentNotFoundError: If the appointment does not exist.
        SlotUnavailableError: If the requested slot is no longer available.
        PermissionDeniedError: If the user is not allowed to modify this appointment.
    """
```

---

## 6. Comments

- Comments must explain **why**, not **what**.
- Do not write comments that simply repeat the code.
- Prefer self-documenting code over comments.
- Use `TODO` comments sparingly and always include context + owner:

```python
# TODO(backend): Replace naive retry with tenacity after rate-limit strategy is finalized.
```

- Deleted code should be removed, not commented out.

---

## 7. Project Structure & Architecture

- Follow the monorepo structure defined in the repository root.
- Do not create new top-level directories without explicit discussion.
- Shared logic belongs in `packages/`.
- Feature-specific logic stays inside the relevant app or service.
- Avoid circular dependencies at all costs.
- Keep domain logic independent from frameworks when possible (clean architecture mindset).

---

## 8. Error Handling

- Use custom domain exceptions (example: `AppointmentNotFoundError`, `SlotUnavailableError`).
- Never swallow exceptions silently.
- Always include relevant context when logging errors (`request_id`, `user_id`, `appointment_id`, etc.).
- Return consistent and clean error responses to clients.
- Distinguish between expected domain errors and unexpected system errors.

---

## 9. Logging

- Use structured logging.
- Log levels must be used correctly:
  - `DEBUG` → detailed diagnostic information
  - `INFO` → normal operations
  - `WARNING` → unexpected but recoverable situations
  - `ERROR` → failures that need attention
- Never log sensitive data (tokens, passwords, full phone numbers, etc.).
- Prefer English for all log messages.

---

## 10. Testing

- Critical business logic must have unit tests.
- Prefer pure functions (easier to test).
- Test names must be descriptive and written in English:

```python
def test_reschedule_appointment_raises_error_when_slot_is_taken():
    ...
```

- Aim for high coverage on domain logic, not necessarily on every trivial getter.

---

## 11. API Design (Backend)

- Follow RESTful conventions or clear RPC-style if using tRPC/GraphQL.
- Use consistent response envelopes.
- Version APIs when breaking changes are introduced.
- Validate all inputs at the boundary.
- Return appropriate HTTP status codes.

---

## 12. Database & Data Modeling

- Use clear and consistent table/column naming (`snake_case`).
- Prefer explicit foreign keys.
- Avoid storing derived data unless there is a clear performance reason.
- Every table should have `created_at` and `updated_at` timestamps.
- Soft deletes are preferred over hard deletes for important business entities.

---

## 13. Security & Privacy

- Never hardcode secrets.
- Use environment variables or a secret manager.
- Validate and sanitize all external inputs.
- Apply the principle of least privilege.
- Be careful with PII (phone numbers, names, medical-related data).

---

## 14. Git & Commit Rules

- Commit messages must be written in English.
- Use conventional commit style when possible:

```
feat: add reschedule appointment support
fix: handle concurrent slot booking race condition
docs: update AGENTS.md with logging standards
```

- Keep commits focused and atomic.
- Do not commit generated files, secrets, or large binary assets.

---

## 15. AI Agent Specific Rules

When an AI agent works on this repository it must:

1. Read relevant existing files before writing new code.
2. Prefer editing existing files over creating new ones.
3. Strictly follow all naming, docstring, language, and structure rules above.
4. Avoid introducing new dependencies unless clearly justified.
5. Keep changes minimal and focused on the requested task.
6. After finishing, provide a short summary of what was changed and why.
7. Never invent non-existent files, functions, or APIs.
8. When in doubt, ask for clarification instead of making assumptions.

---

## 16. Scalability Mindset

Even during MVP, write code with the following assumptions:

- Multiple tenants will exist
- Multiple communication channels will be supported (WhatsApp, Voice, SMS, Web)
- Multiple verticals will be supported (clinic, dental, salon, physiotherapy, HVAC, etc.)
- Traffic may grow 10x–50x

This does **not** mean over-engineering.  
It means clean boundaries, good naming, explicit dependencies, and avoiding hard-coded assumptions.

---

## 17. Decision Rule for AI Agents

When facing a design choice, prefer the option that scores higher on:

1. Readability  
2. Explicitness  
3. Testability  
4. Consistency with existing code  
5. Long-term maintainability  

---

**End of AGENTS.md**

> These standards are living. Propose improvements through a pull request when you find gaps.
