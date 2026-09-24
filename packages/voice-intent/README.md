# @repo/voice-intent

Transcript-only parsing and consent-card construction for voice-note
rescheduling. The package accepts text; it does not perform speech-to-text,
text-to-speech, audio upload, queueing, or calendar writes.

## Contract

- `parse_voice_note_transcript(transcript, options?)` returns a `VoiceNoteIntent`
  with a confidence score, a complete `ProposedSlot` when both date and time
  are known, and an `unresolved` list otherwise.
- `build_consent_card(proposed_slot)` returns a canonical card with the local
  weekday, date, time, IANA timezone, `Confirm`, `Other day`, and `Cancel`
  actions. Button labels are at most 20 characters.
- `requires_confirmation` is always `true`. A parsed voice note never writes a
  booking by itself.

## Deterministic language support

The parser handles common Indonesian and code-switched expressions such as
`pak radiografer bisa kamis?`, `besok sore`, `senin dpn jam 2 siang`, `lusa
pagi`, `jam 4`, and `nanti malam`. Broad periods use deterministic proposal
anchors (`pagi` 09:00, `siang` 12:00, `sore` 15:00, `malam` 19:00); the card
still requires an explicit customer tap before the proposal can be used.

Ambiguous input is never guessed. A date-only or time-only request remains
unresolved, and callers should ask one clarification question before building a
card. The default timezone is `Asia/Jakarta`; pass `{ timezone, now }` in
production when tenant context supplies a different reference.

## Local checks

```bash
pnpm install
npx tsc --noEmit
npx vitest run
```
