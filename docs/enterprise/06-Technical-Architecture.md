# 06 — Technical Architecture

## 6.1 Overview

Chat/voice → channel connector → orchestration agent → availability engine → PMS/calendar writer → notifier → analytics. Semua tulis slot lewat satu writer dengan lock, tidak langsung dari LLM.

## 6.2 Components

- Conversational AI: LLM + NLU tanggal/jam + guardrail slot + confirmation step.
- Orchestration: LangGraph/custom; session + context (Redis), trace (Langfuse/Helicone).
- Connectors: WhatsApp Cloud API (BSP: Qiscus/Wati bila perlu), SMS, voice (STT-LLM-TTS-telephony).
- Integrations: Google/Outlook + 1 PMS/FSM prioritas (Open Dental / Mangomint / Jobber). Tambah bertahap.
- Data: PostgreSQL + Redis; audit log setiap booking/cancel/reschedule.

## 6.3 Stack (rekomendasi awal, bukan lock-in)

WhatsApp Cloud API, Claude/GPT series untuk reasoning ID, LangGraph, PostgreSQL + Redis, Vercel/Railway/AWS (low latency).

## 6.4 Security & Compliance

- Minimisasi data; retensi chat jelas; export text/call log saat churn (diferensiasi karena incumbent tidak publish).
- Kesehatan: BAA/SSO/VPC/on-prem di tier enterprise; JWT; compliance doc under NDA (benchmark Bland Enterprise).
- Indonesia: [Asumsi] validasi UU PDP untuk data kesehatan; mulai dari salon/HVAC untuk hindari risiko awal.

## 6.5 Scalability & Reliability

- Load-test burst Senin pagi; queue + rate-limit WhatsApp/SMS; idempotency writer; uptime target eksplisit di kontrak (karena Weave tidak publish SLA — jadikan keunggulan).
- Voice: uji 5-vendor stack (STT-LLM-TTS-telephony-CRM) agar tidak gagal diam-diam saat scale.

## 6.6 Build vs Buy

- Buy: WhatsApp BSP, SMS gateway, voice infra, hosting, observability.
- Build: orchestration, availability engine, PMS writer, waitlist matcher, dashboard.
- Jangan build LLM/STT/TTS sendiri.
