# ERD — Sela appointments

> Render: paste ke Mermaid live editor / GitHub. Sumber pola: Redgate appointment model (appointment sebagai pusat + service/employee/schedule) dimulti-tenantkan + hold/outbox/audit dari `03-Technical/05`.
> https://www.red-gate.com/blog/a-database-model-to-manage-appointments-and-organize-schedules/

```mermaid
erDiagram
    tenants ||--o{ memberships : has
    tenants ||--o{ services : owns
    tenants ||--o{ resources : owns
    tenants ||--o{ appointments : owns
    tenants ||--o{ appointment_holds : owns
    tenants ||--o{ outbox : emits
    tenants ||--o{ audit_log : records
    tenants ||--o{ message_log : logs
    services ||--o{ appointments : booked_as
    resources ||--o{ appointments : assigned
    resources ||--o{ appointment_holds : held
    appointments ||--o{ appointment_holds : precedes
    appointments {
        uuid id PK
        bigint tenant_id FK
        bigint resource_id FK
        bigint service_id FK
        text customer_ref
        text status
        timestamptz starts_at
        timestamptz ends_at
        timestamptz hold_expires_at
        text idempotency_key
        timestamptz deleted_at
        timestamptz created_at
        timestamptz updated_at
    }
    appointment_holds {
        bigint id PK
        bigint tenant_id FK
        bigint resource_id FK
        timestamptz slot_start
        timestamptz slot_end
        text token_UK
        timestamptz expires_at
        timestamptz created_at
    }
    outbox {
        bigint id PK
        bigint tenant_id FK
        text aggregate_type
        text aggregate_id
        text event_type
        jsonb payload
        text idempotency_key_UK
        text status
        timestamptz available_at
        timestamptz created_at
    }
```
