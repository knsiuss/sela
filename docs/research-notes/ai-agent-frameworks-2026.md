# AI Agent Frameworks & Build Strategy 2026

> Riset Firecrawl 23 Sep 2026. Strategi build produk appointment agent pakai full AI agent.

## 1. Harness vs framework (definisi yang dipakai)

- Harness = yang menjalankan 1 agent (tool execution, sandbox, memory, compaction, approval gates). Contoh: OpenCode, Claude Code, Codex.
- Framework = yang mengomposisikan banyak agent (LangGraph stateful loops, CrewAI roles/Flows, Microsoft Agent Framework sequential/concurrent/handoff/group-chat, OpenAI Agents SDK handoffs+guardrails).
- Meta-harness = orkestrasi banyak harness (Omnigent, Proliferate, AgentBox VM-per-agent, YYLO git-native merge queue).
- Aturan praktis: untuk tim kita, harness matters less than workspace di atasnya saat jalan paralel.

SoT:
- https://winder.ai/ai-agent-harness-comparison/
- https://www.langchain.com/resources/ai-agent-frameworks
- https://github.com/ryanalberts/best-of-agent-harnesses
- https://nimbalyst.com/blog/best-ai-coding-agents-2026/ (OpenCode = open-source terkuat yang bisa point ke provider apa pun)

## 2. Keputusan harness untuk produk ini

Tetap OpenCode sebagai harness utama (sudah jalan di sesi ini + subagent depth 2 + MCP firecrawl/context7/github/supabase). Alasan: open-source, multi-provider, subagent background paralel terbukti (5 riset paralel sesi ini). Jangan tambah harness kedua sebelum bottleneck terbukti.
Pola eksekusi yang dipakai: 1 orchestrator (sesi ini) + subagent spesialis paralel (backend, frontend, research, audit, security) + verifikasi eksekusi tiap hasil (run/test/scrape, bukan IQ).

## 3. Agent Skills (Anthropic spec) — SOP agar agent konsisten

Skills = folder berisi instruksi + skrip + referensi yang mengajarkan agent workflow kompleks (bedakan dari MCP yang memberi TOOLS). WWII: MCP = tangan, Skills = SOP.
- Spec publik: https://github.com/anthropics/skills (folder `spec`)
- Engineering: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Code execution + MCP efisiensi konteks: https://www.anthropic.com/engineering/code-execution-with-mcp
- Menulis tools untuk agent (desain untuk agent, bukan developer): https://www.anthropic.com/engineering/writing-tools-for-agents
- Best practice struktur (deny-by-default tooling): https://medium.com/intuitionmachine/structuring-agents-skills-and-mcps-best-practices-from-anthropic-9312849ccea6

Skills yang perlu kita buat untuk produk ini (masing-masing 1 folder):
1. `pms-writeback` — SOP tulis slot (hold → confirm → idempotent write → audit log). Anti double-book.
2. `wa-template-compliance` — klasifikasi Marketing/Utility/Auth + opt-in logging (aturan Meta 2026).
3. `reschedule-flow` — intent → 2-3 opsi → rebook → notif staf + handoff threshold.
4. `pilot-eval` — cara ukur recovered revenue + sample size + baseline.
5. `handoff-rules` — 6 prinsip D-05 sebagai checklist eskalasi.

## 4. MCP yang dibutuhkan (build + runtime)

| MCP | Untuk | Status |
|---|---|---|
| firecrawl (cloud) | riset search | aktif |
| firecrawl_local (D:\firecrawl :3002) | scrape/crawl/parse bebas limit | setup berjalan |
| context7 | docs library terkini sebelum koding | aktif |
| github | repo ops | aktif |
| supabase | Postgres + auth + storage produk | aktif |
| gcal-mcp (baru) | availability/hold/book MVP | OPEN — build atau pakai existing |
| pms adapter MCP (baru, 1 per PMS) | write-back vertikal | OPEN setelah beachhead |
| whatsapp BSP | kirim/baca chat (via API, bukan selalu MCP) | evaluasi |

Prinsip Anthropic: deny-by-default — tiap agent hanya diberi MCP yang dibutuhkan perannya (backend dapat DB+API, frontend tidak).

## 5. Strategi multi-agent build (yang sudah dipakai sesi ini)

- Orchestrator pecah per angle → subagent paralel background → sintesis + tulis docs dengan SoT.
- Peran tetap: backend (API/writer/lock), frontend (dashboard), researcher (Firecrawl), auditor (first-principles + code audit), security (OWASP + BAA/PDP).
- Aturan anti-gagal: subagent dilarang tulis file yang sama (topik non-overlapping); orchestrator satu-satunya penulis; tiap klaim kode diverifikasi eksekusi.
- Evaluasi: pilot metrics dari deep research (berjalan) jadi acceptance gate, bukan demo.

## 6. Batasan riset ini

Perbandingan harga/detail tiap harness tidak dikutip (butuh trial). Pilihan LangGraph vs CrewAI vs MS Agent Framework untuk runtime PRODUK (bukan harness build) diputus di `03-Technical/03-AI-Agent-Framework-Choice.md` setelah MVP scope kunci.
