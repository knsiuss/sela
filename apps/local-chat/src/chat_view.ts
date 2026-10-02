/**
 * Server-rendered chat surface.
 *
 * Pure string building: no framework, no `dangerouslySetInnerHTML`, and every
 * interpolated value is escaped. The environment warning is the *same*
 * `LocalOnlyBanner` component the operator dashboard renders, so the two local
 * surfaces cannot drift into different security framings.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { LocalOnlyBanner } from "@repo/ui";
import type { PublicChatView } from "./chat_conversation.js";

/** Values the page needs that are fixed by the server configuration. */
export interface ChatPageContext {
  tenant_id: string;
  role: string;
  webhook_path: string;
  reply_timeout_ms: number;
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.5rem;
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: Canvas; color: CanvasText;
}
.wrap { max-width: 46rem; margin: 0 auto; display: grid; gap: 1rem; }
h1 { font-size: 1.25rem; margin: 0; }
.lede { margin: 0; opacity: 0.75; font-size: 0.9rem; }
.banner {
  padding: 0.75rem 1rem; border: 1px solid #b45309; border-left-width: 3px;
  border-radius: 8px; background: #fff7ed; color: #7c2d12;
}
.banner__title { margin: 0 0 0.35rem; font-size: 0.85rem; font-weight: 650; }
.banner__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.25rem; font-size: 0.85rem; }
.transcript {
  margin: 0; padding: 0; list-style: none; display: grid; gap: 0.6rem;
  min-height: 14rem; max-height: 26rem; overflow-y: auto;
  border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 0.9rem;
}
.entry { display: grid; gap: 0.3rem; max-width: 85%; }
.entry--end_user { justify-self: end; text-align: right; }
.entry--agent { justify-self: start; }
.entry--system { justify-self: center; max-width: 100%; font-size: 0.82rem; font-style: italic; opacity: 0.8; }
.entry__who { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
.entry__text { margin: 0; white-space: pre-wrap; }
.entry--end_user .entry__text { background: color-mix(in srgb, CanvasText 8%, transparent); border-radius: 10px; padding: 0.45rem 0.65rem; display: inline-block; }
.entry--agent .entry__text { background: color-mix(in srgb, CanvasText 5%, transparent); border-radius: 10px; padding: 0.45rem 0.65rem; display: inline-block; }
.entry__buttons { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.quick-reply {
  font: inherit; font-size: 0.85rem; cursor: pointer; padding: 0.3rem 0.7rem;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  border-radius: 999px; background: Canvas; color: CanvasText;
}
.quick-reply:hover { border-color: color-mix(in srgb, CanvasText 60%, transparent); }
.composer { display: flex; gap: 0.5rem; }
.composer input {
  flex: 1; font: inherit; padding: 0.5rem 0.7rem; border-radius: 8px;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  background: Canvas; color: CanvasText;
}
button.primary, button.secondary {
  font: inherit; cursor: pointer; padding: 0.5rem 0.9rem; border-radius: 8px;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  background: Canvas; color: CanvasText;
}
.evidence { font-size: 0.78rem; opacity: 0.75; font-variant-numeric: tabular-nums; }
.toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
`;

/**
 * Render the whole chat page as a static document.
 *
 * @param view - Conversation projection safe for the browser.
 * @param context - Server-fixed persona and timeout values.
 * @returns A complete HTML document.
 */
export function render_chat_page(view: PublicChatView, context: ChatPageContext): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    "<title>End-user chat (local only)</title>",
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    '<div class="wrap">',
    "<main>",
    "<h1>End-user chat with the booking agent</h1>",
    `<p class="lede">You are the WhatsApp customer. Your message is signed with a synthetic app secret on the server and posted to <code>${escape_html(context.webhook_path)}</code> on the real agent.</p>`,
    renderToStaticMarkup(LocalOnlyBanner({ tenant_id: context.tenant_id, role: context.role })),
    render_transcript(view),
    render_evidence(view),
    render_composer(),
    render_toolbar(context),
    "</main>",
    "</div>",
    '<script src="/chat/client.js" defer></script>',
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Render the transcript as an ordered list of conversation lines.
 *
 * @param view - Conversation projection.
 * @returns The transcript region, including the empty state.
 */
export function render_transcript(view: PublicChatView): string {
  const lines = view.entries.length === 0
    ? '<li class="entry entry--system"><p class="entry__text">No messages yet. Ask the agent for an appointment to begin.</p></li>'
    : view.entries.map(render_entry).join("\n");
  return `<h2 class="entry__who" id="transcript-label">Conversation</h2>\n<ol class="transcript" id="transcript" aria-labelledby="transcript-label" role="log" aria-live="polite">\n${lines}\n</ol>`;
}

/**
 * Render the last observed ingress and delivery values.
 *
 * @param view - Conversation projection.
 * @returns The evidence line, or an empty string before the first turn.
 */
export function render_evidence(view: PublicChatView): string {
  const with_evidence = [...view.entries].reverse().find((entry) => entry.evidence !== undefined);
  if (with_evidence?.evidence === undefined) {
    return '<p class="evidence" id="evidence">No ingress call yet.</p>';
  }
  const found = with_evidence.evidence;
  const parts = [
    `HTTP ${found.http_status}`,
    `request_id ${found.request_id ?? "n/a"}`,
    `wamid ${found.wamid}`,
    `enqueued ${found.enqueued_count}`,
    `duplicate ${found.duplicate_count}`,
    `unresolved ${found.unresolved_count}`,
    `outbound ${found.provider_wamids.length === 0 ? "none" : found.provider_wamids.join(", ")}`,
  ];
  if (found.error !== undefined) parts.push(`error ${found.error}`);
  return `<p class="evidence" id="evidence">${escape_html(parts.join(" | "))}</p>`;
}

function render_entry(entry: PublicChatView["entries"][number]): string {
  const buttons = entry.buttons
    .map((button) =>
      `<button type="button" class="quick-reply" data-button-id="${escape_html(button.id)}">${escape_html(button.label)}</button>`,
    )
    .join("");
  const who = entry.role === "agent" ? "Booking agent" : entry.role === "end_user" ? "You" : "Chat client";
  return [
    `<li class="entry entry--${entry.role}">`,
    `<span class="entry__who">${escape_html(who)}</span>`,
    `<p class="entry__text">${escape_html(entry.text)}</p>`,
    buttons === "" ? "" : `<div class="entry__buttons">${buttons}</div>`,
    "</li>",
  ].join("");
}

function render_composer(): string {
  return [
    '<form class="composer" id="composer">',
    '<label class="entry__who" for="message">Your message</label>',
    '<input id="message" name="message" type="text" autocomplete="off" maxlength="4096" required>',
    '<button class="primary" type="submit">Send</button>',
    "</form>",
  ].join("\n");
}

function render_toolbar(context: ChatPageContext): string {
  return [
    '<div class="toolbar">',
    '<button class="secondary" type="button" id="new-session">New end user</button>',
    '<button class="secondary" type="button" id="redeliver">Redeliver last message</button>',
    '<button class="secondary" type="button" id="self-check">Send with a bad signature</button>',
    `<span class="evidence">reply wait ${context.reply_timeout_ms} ms</span>`,
    "</div>",
  ].join("\n");
}

/**
 * Render the browser script that drives the page.
 *
 * Same-origin only, no eval, no external origin, and it re-renders from the
 * server response rather than trusting anything it built locally.
 *
 * @returns A classic script document.
 */
export function render_client_script(): string {
  return [
    '"use strict";',
    "var transcript = document.getElementById('transcript');",
    "var evidence = document.getElementById('evidence');",
    "var composer = document.getElementById('composer');",
    "var message = document.getElementById('message');",
    "",
    "function setBusy(busy) {",
    "  document.querySelectorAll('button, input').forEach(function (node) { node.disabled = busy; });",
    "}",
    "",
    "function escapeText(value) {",
    "  var div = document.createElement('div');",
    "  div.textContent = value;",
    "  return div.innerHTML;",
    "}",
    "",
    "function renderEntry(entry) {",
    "  var who = entry.role === 'agent' ? 'Booking agent' : (entry.role === 'end_user' ? 'You' : 'Chat client');",
    "  var html = '<li class=\"entry entry--' + escapeText(entry.role) + '\">';",
    "  html += '<span class=\"entry__who\">' + escapeText(who) + '</span>';",
    "  html += '<p class=\"entry__text\">' + escapeText(entry.text) + '</p>';",
    "  if (entry.buttons.length > 0) {",
    "    html += '<div class=\"entry__buttons\">';",
    "    entry.buttons.forEach(function (button) {",
    "      html += '<button type=\"button\" class=\"quick-reply\" data-button-id=\"' + escapeText(button.id) + '\">' + escapeText(button.label) + '</button>';",
    "    });",
    "    html += '</div>';",
    "  }",
    "  html += '</li>';",
    "  return html;",
    "}",
    "",
    "function renderView(view) {",
    "  transcript.innerHTML = view.entries.map(renderEntry).join('');",
    "  var last = view.entries.slice().reverse().filter(function (e) { return e.evidence; })[0];",
    "  if (last === undefined) { evidence.textContent = 'No ingress call yet.'; return; }",
    "  var f = last.evidence;",
    "  var parts = ['HTTP ' + f.http_status, 'request_id ' + (f.request_id || 'n/a'), 'wamid ' + f.wamid,",
    "    'enqueued ' + f.enqueued_count, 'duplicate ' + f.duplicate_count, 'unresolved ' + f.unresolved_count,",
    "    'outbound ' + (f.provider_wamids.length === 0 ? 'none' : f.provider_wamids.join(', '))];",
    "  if (f.error) parts.push('error ' + f.error);",
    "  evidence.textContent = parts.join(' | ');",
    "  transcript.scrollTop = transcript.scrollHeight;",
    "}",
    "",
    "function post(path, body) {",
    "  setBusy(true);",
    "  return fetch(path, {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify(body),",
    "  }).then(function (response) { return response.json().then(function (value) {",
    "    return { ok: response.ok, value: value };",
    "  }); }).then(function (result) {",
    "    if (result.value && result.value.view) renderView(result.value.view);",
    "    return result;",
    "  }).finally(function () { setBusy(false); });",
    "}",
    "",
    "composer.addEventListener('submit', function (event) {",
    "  event.preventDefault();",
    "  var text = message.value.trim();",
    "  if (text === '') return;",
    "  message.value = '';",
    "  post('/chat/turns', { kind: 'text', text: text });",
    "});",
    "",
    "transcript.addEventListener('click', function (event) {",
    "  var target = event.target.closest('button[data-button-id]');",
    "  if (target === null) return;",
    "  post('/chat/turns', { kind: 'button', button_id: target.getAttribute('data-button-id') });",
    "});",
    "",
    "document.getElementById('new-session').addEventListener('click', function () {",
    "  post('/chat/sessions', {});",
    "});",
    "",
    "document.getElementById('redeliver').addEventListener('click', function () {",
    "  post('/chat/redeliver', {});",
    "});",
    "",
    "document.getElementById('self-check').addEventListener('click', function () {",
    "  post('/chat/signature-self-check', { kind: 'text', text: 'I want to book an appointment' });",
    "});",
  ].join("\n");
}

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * @param value - Any untrusted string.
 * @returns The escaped string.
 */
export function escape_html(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
