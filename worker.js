import {
  sumSystem, trSystem, FIX_SYSTEM, TODO_SYSTEM, ASK_PLAIN_SYSTEM, ASK_ABOUT_MESSAGE_SYSTEM, ASK_FOLLOWUP_SYSTEM, linkSummarySystem, pdfSummaryPrompt, IMAGE_EXTRACT_PROMPT, GEMINI_PROMPT, reminderSpecSystem,
} from "./prompts.js";
import {CONFIG, DAY_MS, MAX_FILE_BYTES, GEMINI_INLINE_MAX, MAX_TEXT, CHUNK_CHARS, WHISPER_RESERVE_MS, WHISPER_MODEL, ASK_HISTORY_CHARS, PAGE_MAX_BYTES, PDF_MAX_BYTES, PAGE_TIMEOUT_MS, LINK_ONLY_MAX_TEXT, TEHRAN_OFFSET_MS, MAX_REMINDERS, MAX_AHEAD_MS, SHORT_ID_LEN, FIX_WARNING, TR_WARNING, FULL_TEXT_NOTE, ASK_MARK, COMMANDS, TEXT_COMMANDS, TASK_LABEL, SNOOZE_KEYBOARD, J_MONTHS, G_MONTHS_FA, DOW_FA, DOW_EN, WEEKDAY_KEYS, REPEAT_KINDS, J_MONTH_FORMS, J_MONTH_ALT, CB_DONE, CB_SNOOZE_TOMORROW, SNOOZE_MINUTES, RETRY_SENSITIVE_COMMANDS,
} from "./config.js";


const cfg = (env, key) => env[key] ?? CONFIG[key];
const cfgFlag = (env, key) => {
  const v = cfg(env, key);
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
};
const cfgList = (env, key) => {
  const v = cfg(env, key);
  return (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRY_SENSITIVE_RE = new RegExp(`^\\/(?:${RETRY_SENSITIVE_COMMANDS.join("|")})\\b`, "i");


/* ---------------- Entry point ---------------- */

export default {
  async fetch(request, env, ctx) {
    const ownerIds = cfgList(env, "ADMIN_CHAT_IDS").filter((id) => /^\d+$/.test(id));
    if (request.method !== "POST") {
      if (!ownerIds.length) {
        return new Response("Configuration error: ADMIN_CHAT_IDS is not set to a numeric Telegram user ID.", { status: 503 });
      }
      return new Response("👁 دستیار بیداره... ولی فقط به تلگرام جواب می‌ده.", { status: 200 });
    }

    const secret = cfg(env, "WEBHOOK_SECRET");
    if (!secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (!ownerIds.length) {
      console.error("Configuration error: ADMIN_CHAT_IDS is not set to a numeric Telegram user ID.");
      if (update.message?.chat?.type === "private") {
        try {
          await tg(env, "sendMessage", {
            chat_id: update.message.chat.id,
            text: "⚠️ بات هنوز راه‌اندازی نشده است. شناسهٔ عددی مالک را در تنظیمات Cloudflare و در متغیر ADMIN_CHAT_IDS ثبت کنید.",
          });
        } catch (err) {
          console.error("Could not send the missing-owner notice:", err);
        }
      }
      return new Response("ADMIN_CHAT_IDS is not configured", { status: 200 });
    }

    if (!isOwner(env, updateSender(update))) return new Response("ok", { status: 200 });

    if (isSttUpdate(update) && (await seenBefore(env, update.update_id))) {
      return new Response("ok", { status: 200 });
    }

    const work = handleUpdate(update, env).catch((err) => console.error("handleUpdate failed:", err));
    ctx.waitUntil(work);
    await work;
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueReminders(env).catch((err) => console.error("runDueReminders failed:", err)));
  },
};

function updateSender(update) {
  return (update.message || update.guest_message || update.callback_query)?.from?.id;
}

function isSttUpdate(update) {
  return !!(
    update.guest_message ||
    update.callback_query ||
    update.message?.voice ||
    update.message?.reply_to_message?.from?.is_bot || // a reply to the bot may continue an /ask conversation
    RETRY_SENSITIVE_RE.test(update.message?.text || "")
  );
}

async function seenBefore(env, updateId) {
  if (!env.DB || updateId == null) return false;
  try {
    const r = await env.DB
      .prepare("INSERT OR IGNORE INTO seen_updates (id, at) VALUES (?, ?)")
      .bind(updateId, Date.now())
      .run();
    return (r.meta?.changes || 0) === 0;
  } catch (err) {
    console.error("seenBefore failed:", err);
    return false;
  }
}

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.guest_message) return handleGuest(update.guest_message, env);
  if (update.message) return handlePrivate(update.message, env);
}

/* ---------------- Reply commands ---------------- */

const hasCommand = (name) => Object.prototype.hasOwnProperty.call(COMMANDS, name);

function parseCommand(text, botName = "") {
  const mention = botName ? "@" + String(botName).toLowerCase() : "";
  let tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  tokens = tokens.filter((t) => !(mention && t.toLowerCase().replace(/[^\w@]+$/, "") === mention));
  while (tokens.length && tokens[0].startsWith("@")) tokens.shift();   // leading mentions are not the command
  const token = tokens[0] || "";
  const slash = token.startsWith("/");
  const name = token.replace(/^\//, "").replace(/@\w+$/, "").toLowerCase();
  return { name, slash, known: hasCommand(name), args: tokens.slice(1).join(" ").trim() };
}

function sttMedia(env, m) {
  if (!m) return null;
  let kinds = cfgList(env, "STT_MEDIA");
  if (!kinds.length) kinds = ["voice"];
  for (const kind of kinds) if (m[kind]) return m[kind];
  return null;
}

function pdfDocument(m) {
  const d = m?.document;
  return d && (d.mime_type === "application/pdf" || /\.pdf$/i.test(d.file_name || "")) ? d : null;
}

function imageMedia(m) {
  if (!m) return null;
  if (Array.isArray(m.photo) && m.photo.length) {
    const available = m.photo.filter((p) => !p.file_size || p.file_size <= GEMINI_INLINE_MAX);
    const photo = (available.length ? available : m.photo).at(-1);
    return { ...photo, mime_type: "image/jpeg" };
  }
  const d = m.document;
  if (!d) return null;
  const ext = String(d.file_name || "").split(".").pop().toLowerCase();
  const type = String(d.mime_type || "").toLowerCase();
  const mime = ["image/jpeg", "image/png", "image/webp"].includes(type)
    ? type
    : ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" })[ext];
  return mime ? { ...d, mime_type: mime } : null;
}

/* ---------------- Private chat ---------------- */

async function handlePrivate(msg, env) {
  if (msg.chat?.type !== "private") return;
  if (!isOwner(env, msg.from?.id)) return;

  const chatId = msg.chat.id;
  try {
    const own = sttMedia(env, msg);
    if (own) {
      if (cfgFlag(env, "AUTO_TRANSCRIBE_DIRECT_VOICE")) return await replyTranscript(env, msg, own);
      return; // no hint, no answer
    }

    const userMsg = (msg.text || "").trim();
    if (!userMsg) return;

    const parsed = parseCommand(userMsg);
    if (parsed.slash && parsed.name === "stt") {
      const target = sttMedia(env, msg.reply_to_message);
      if (!target) return; // /stt without a voice to act on: no answer
      return await replyTranscript(env, msg, target, msg.reply_to_message.message_id);
    }

    if (parsed.slash && parsed.name === "remind") return await replyRemind(env, msg, parsed.args);
    if (parsed.slash && parsed.name === "reminders") return await replyReminderList(env, chatId);
    if (parsed.slash && parsed.name === "unremind") return await replyUnremind(env, chatId, parsed.args);

    if (parsed.slash && parsed.name === "ask") return await privateAsk(env, msg, parsed.args);

    if (parsed.slash && parsed.name === "sum") {
      const target = msg.reply_to_message;
      const doc = pdfDocument(target);
      if (doc) {
        return await replyTask(env, msg, "خواندن و خلاصه‌ی PDF", "📄 فایل دریافت شد.", () => runPdfFileSummary(env, doc), target.message_id);
      }
      const urls = linkTargets(env, target, parsed.args);
      if (urls.length) {
        const replyToId = target?.message_id || msg.message_id;
        return await replyTask(env, msg, "خواندن و خلاصه‌ی لینک", "🔗 لینک دریافت شد.", () => runLinkSummary(env, urls), replyToId);
      }
    }

    if (parsed.slash && parsed.name === "extract") {
      const target = msg.reply_to_message;
      const image = imageMedia(target);
      if (image) {
        return await replyTask(
          env, msg, "استخراج اطلاعات از عکس", "🖼 عکس دریافت شد.",
          () => runImageExtract(env, image, replyText(env, target)), target.message_id
        );
      }
    }

    if (parsed.slash && TEXT_COMMANDS.has(parsed.name)) {
      const source = replyText(env, msg.reply_to_message);
      if (!source) return; // nothing to work on: no answer
      const replyToId = msg.reply_to_message.message_id;
      return await replyTextTask(env, msg, parsed.name, parsed.args, source, replyToId);
    }

    if (parsed.slash && parsed.name === "start") {
      return void (await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          "بات شخصی.\nراهنما: /help",
      }));
    }

    if (parsed.slash && parsed.name === "help") {
      const uname = await botUsername(env);
      const mention = uname ? "@" + uname : "@username_bot";
      return void (await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          `دستورات:
/start
/help

🎙 صوت به متن:
• /stt — روی یک ویس ریپلای کنید.
📝 دستورهای ریپلای روی متن:
• /sum — خلاصه
   روی پیامی که لینک است: صفحه را باز و خلاصه می‌کند (یا /sum <لینک>). برای پیام بلندِ لینک‌دار: /sum لینک
   روی فایل PDF: خلاصه‌ی سند
• /tr <زبان> — ترجمه، مثلاً /tr english
• /fix — اصلاح نگارش
• /ask <سؤال> — مشورت درباره‌ی همان پیام (بدون سؤال یعنی «چی جواب بدم؟»)
   بدون ریپلای هم کار می‌کند: /ask سؤالت
   برای ادامه‌ی گفتگو، روی جواب ریپلای کنید و سؤال بعدی را بنویسید.
• /todo — استخراج کارها (چی، توسط کی، تا کی)
• /extract — شماره، لینک، ایمیل، تاریخ، ساعت و مبلغ (متن یا عکس)

⏰ یادآوری (به وقت تهران):
• /remind <زمان> [موضوع] — مثلاً /remind فردا ۹ صبح یا /remind ۲ ساعت دیگه زنگ بزنم به علی (ریپلای روی پیام هم می‌شه)
   ساعت ۱ تا ۶ بدون «صبح» یعنی بعدازظهر؛ برای صبح زود بنویس «۵ صبح».
   تکرار: /remind هر روز ساعت ۹ قرص — هر شنبه، هر ماه ۵ام، هر سال ۱۰ تیر
• /reminders — لیست یادآوری‌ها (هر کدام با یک کد)
• /unremind <کد یا all> — حذف
• در چت‌های دیگر: ریپلای کنید و بنویسید ${mention} sum`,
      }));
    }

    if (!parsed.slash && msg.reply_to_message) {
      const history = await askHistoryFor(env, chatId, msg.reply_to_message);
      if (history) return await privateAsk(env, msg, userMsg, history);
    }

  } catch (err) {
    console.error("handlePrivate failed:", err);
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ خطایی رخ داد." });
  }
}

async function replyTranscript(env, msg, media, replyToId = msg.message_id) {
  const chatId = msg.chat.id;
  if (media.file_size && media.file_size > MAX_FILE_BYTES) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "فایل بزرگ‌تر از ۲۰ مگابایت است." });
    return;
  }

  const lines = ["📥 ویس دریافت شد."];
  const ack = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    reply_parameters: { message_id: replyToId },
  });

  const step = async (line) => {
    lines.push(line);
    if (ack?.message_id) {
      await tg(env, "editMessageText", { chat_id: chatId, message_id: ack.message_id, text: lines.join("\n") });
    }
  };

  try {
    const { text, model, reasons } = await transcribeFileId(env, media, step);
    await showParts(
      env, chatId, ack?.message_id,
      text || lines.join("\n") + "\n⚠️ متنی تشخیص داده نشد.",
      model, debugNote(env, reasons), replyToId
    );
  } catch (err) {
    console.error("private transcribe failed:", err);
    const failure = err instanceof FileLimitError ? err.message : "❌ جواب نداد." + errorDetail(env, err);
    await showParts(env, chatId, ack?.message_id, lines.join("\n") + "\n" + failure, "", "", replyToId);
  }
}

/* ---------------- Guest mode ---------------- */

async function handleGuest(msg, env) {
  if (!isOwner(env, msg.from?.id)) return; // stay silent for everyone else (and never log their messages)
  if (cfgFlag(env, "DEBUG")) console.log("GUEST UPDATE:", JSON.stringify(msg));

  const qid = msg.guest_query_id;
  if (!qid) return;

  if (!(await mentionsBot(env, msg))) return;
  const cmd = parseCommand(msg.text || msg.caption, (await botUsername(env)) || "");
  if (!cmd.known) return;
  if (cmd.name === "ask") return await guestAsk(env, msg, qid, cmd);
  if (cmd.name === "sum") {
    const doc = pdfDocument(msg.reply_to_message);
    if (doc) return await guestRun(env, msg, qid, "pdf", () => runPdfFileSummary(env, doc));
    const urls = linkTargets(env, msg.reply_to_message, cmd.args);
    if (urls.length) return await guestRun(env, msg, qid, "link", () => runLinkSummary(env, urls));
  }
  if (TEXT_COMMANDS.has(cmd.name)) return await guestTextTask(env, msg, qid, cmd);
  if (cmd.name === "remind") return await guestRemind(env, msg, qid, cmd);
  if (cmd.name !== "stt") return;
  const media = findMedia(env, msg);
  if (!media) return;

  if (media.file_size && media.file_size > MAX_FILE_BYTES) {
    await answerGuest(env, qid, "فایل بزرگ‌تر از ۲۰ مگابایت است و بات نمی‌تواند آن را دانلود کند.");
    return;
  }

  try {
    const { text, model, reasons } = await transcribeFileId(env, media);
    await guestAnswerLong(env, msg, qid, text || "متنی تشخیص داده نشد.", model, debugNote(env, reasons));
  } catch (err) {
    console.error("guest transcribe failed:", err);
    await answerGuest(env, qid, err instanceof FileLimitError ? err.message : "خطا در تبدیل صوت به متن." + errorDetail(env, err));
  }
}

function answerGuest(env, guestQueryId, text) {
  return tg(env, "answerGuestQuery", {
    guest_query_id: guestQueryId,
    result: {
      type: "article",
      id: "stt-" + Date.now(),
      title: "Transcript",
      input_message_content: { message_text: clip(text), link_preview_options: { is_disabled: true } },
    },
  });
}

async function guestAnswerLong(env, msg, qid, text, model = "", extra = "") {
  const full = text || "نتیجه‌ای تولید نشد.";
  if (full.length + extra.length <= MAX_TEXT - 200) {
    await answerGuest(env, qid, withModel(full, model, extra));
    return;
  }
  await answerGuest(env, qid, withModel(clip(full, MAX_TEXT - 300 - extra.length) + "\n\n" + FULL_TEXT_NOTE, model, extra));
  await showParts(env, msg.from.id, null, full, model, extra, null);
}

async function guestRun(env, msg, qid, label, run) {
  try {
    const { text, model } = await run();
    await guestAnswerLong(env, msg, qid, text, model);
  } catch (err) {
    console.error(`guest ${label} failed:`, err);
    await answerGuest(env, qid, err instanceof FileLimitError ? err.message : "خطا." + errorDetail(env, err));
  }
}

/* ---------------- Helpers ---------------- */

function botId(env) {
  return String(cfg(env, "TELEGRAM_BOT_TOKEN") || "").split(":")[0];
}

let cachedBotUsername = null;
async function botUsername(env) {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await tg(env, "getMe", {});
  if (me?.username) cachedBotUsername = String(me.username).toLowerCase();
  return cachedBotUsername;
}

async function mentionsBot(env, msg) {
  const text = String(msg.text || msg.caption || "").toLowerCase();
  const name = await botUsername(env);
  if (name) return new RegExp(`(^|[^\\w@]|\\/\\w+)@${name}(?!\\w)`).test(text);
  return /(^|\s)@\w+/.test(text);
}

function isOwner(env, id) {
  return id != null && cfgList(env, "ADMIN_CHAT_IDS").includes(String(id));
}

function isFromBot(env, m) {
  const id = botId(env);
  return !!(m && id && (String(m.from?.id) === id || String(m.via_bot?.id) === id));
}

function findMedia(env, msg) {
  for (const source of [msg, msg.reply_to_message, msg.external_reply]) {
    const m = sttMedia(env, source);
    if (m) return m;
  }
  return null;
}

function errorDetail(env, err) {
  if (!cfgFlag(env, "DEBUG")) return "";
  return "\n\n[debug] " + String(err?.message || err).slice(0, 500);
}

function clip(text, max = MAX_TEXT) {
  const t = String(text);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function withModel(text, model, extra = "") {
  const body = clip(text, MAX_TEXT - 100 - extra.length);
  return model ? body + "\n\n" + model + extra : body + extra;
}

function debugNote(env, reasons) {
  if (!cfgFlag(env, "DEBUG") || !reasons || !reasons.length) return "";
  return "\n\n[debug] " + reasons.join(" ; ").slice(0, 600);
}

function splitChunks(text, max = CHUNK_CHARS) {
  const chunks = [];
  let cur = "";
  for (let piece of String(text).split(/(?<=\n)|(?<=[.!?؟][ \t])/)) {
    while (piece.length > max) { // a single very long sentence: hard cut
      if (cur) { chunks.push(cur); cur = ""; }
      chunks.push(piece.slice(0, max));
      piece = piece.slice(max);
    }
    if (cur && cur.length + piece.length > max) { chunks.push(cur); cur = ""; }
    cur += piece;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const keepEdges = (orig, out) => orig.match(/^\s*/)[0] + String(out).trim() + orig.match(/\s*$/)[0];

const splitForTelegram = (t, reserve = 0) =>
  splitChunks(t, MAX_TEXT - 150 - reserve).map((s) => s.trim()).filter(Boolean);

async function showParts(env, chatId, ackId, text, model = "", extra = "", replyToId = null) {
  const noPreview = { is_disabled: true };
  const parts = splitForTelegram(text, extra.length);
  if (!parts.length) parts.push("…");
  parts[parts.length - 1] = withModel(parts[parts.length - 1], model, extra);

  const ids = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === 0 && ackId) {
      const ok = await tg(env, "editMessageText", { chat_id: chatId, message_id: ackId, text: parts[0], link_preview_options: noPreview });
      if (ok) { ids.push(ackId); continue; }
    }
    const m = await tg(env, "sendMessage", {
      chat_id: chatId,
      text: parts[i],
      link_preview_options: noPreview,
      reply_parameters: replyToId ? { message_id: replyToId, allow_sending_without_reply: true } : undefined,
    });
    if (m?.message_id) ids.push(m.message_id);
  }
  return ids;
}

async function tg(env, method, payload, retry = true) {
  const url = `https://api.telegram.org/bot${cfg(env, "TELEGRAM_BOT_TOKEN")}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data?.ok) return data.result;

  const wait = Number(data?.parameters?.retry_after) || 0;
  if (retry && res.status === 429 && wait > 0 && wait <= 10) {
    await sleep(wait * 1000);
    return tg(env, method, payload, false);
  }
  console.error(`Telegram ${method} failed:`, res.status, JSON.stringify(data));
  return null;
}

class FileLimitError extends Error {}

function fileLimitMessage(maxBytes) {
  return maxBytes <= GEMINI_INLINE_MAX
    ? "⚠️ فایل برای پردازش با Gemini باید حداکثر ۱۴ مگابایت باشد."
    : "⚠️ فایل بزرگ‌تر از ۲۰ مگابایت است و بات نمی‌تواند آن را دانلود کند.";
}

async function downloadFile(env, fileId, timeoutMs = 10000, maxBytes = MAX_FILE_BYTES) {
  const info = await tg(env, "getFile", { file_id: fileId });
  if (!info?.file_path) throw new Error("getFile failed");
  if (Number(info.file_size) > maxBytes) throw new FileLimitError(fileLimitMessage(maxBytes));
  const res = await fetch(`https://api.telegram.org/file/bot${cfg(env, "TELEGRAM_BOT_TOKEN")}/${info.file_path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error("file download failed: " + res.status);

  const contentLength = Number(res.headers.get("content-length"));
  if (res.headers.has("content-length") && contentLength > maxBytes) {
    await res.body?.cancel();
    throw new FileLimitError(fileLimitMessage(maxBytes));
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new FileLimitError(fileLimitMessage(maxBytes));
    return { buffer, path: info.file_path };
  }

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FileLimitError(fileLimitMessage(maxBytes));
      }
      chunks.push(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch {}
    throw err;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer: bytes.buffer, path: info.file_path };
}

/* ---------------- Text commands: /sum /tr /fix /todo /extract (/ask has its own section) ---------------- */


const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MODEL_FOOTER_RE = new RegExp(`^(?:${escapeRegExp(ASK_MARK)})?(?:gemini|gemma|whisper|normalizer)[^\\n]*$`, "i");

function stripBotFooter(t) {
  const parts = String(t).split("\n\n");
  const isBotNoise = (p) =>
    p.startsWith("[debug]") ||
    MODEL_FOOTER_RE.test(p.trim()) ||
    p.startsWith(FIX_WARNING) ||     // may be followed by " (n از m بخش)"
    p.startsWith(TR_WARNING) ||
    p.startsWith(FULL_TEXT_NOTE) ||
    /^\(فقط \d+ نویسه/.test(p);
  while (parts.length > 1 && isBotNoise(parts[parts.length - 1])) parts.pop();
  return parts.join("\n\n");
}

function replyText(env, m) {
  let t = String(m?.text || m?.caption || "");
  if (isFromBot(env, m)) t = stripBotFooter(t);
  return t.trim() ? t : "";
}

function buildTask(env, name, args, source) {
  const quoted = `"""\n${String(source).replaceAll('"""', "'''")}\n"""`;

  if (name === "sum") {
    const lang = cfg(env, "SUMMARY_LANG") || "Persian";
    return {
      maxTokens: 1000,
      system: sumSystem(lang),
      user: quoted,
    };
  }
  if (name === "tr") {
    const target = args
      ? `the language written here: "${args}"`
      : "none was given, so translate Persian text into English and any other language into Persian";
    return {
      maxTokens: 4096,
      system: trSystem(target),
      user: quoted,
    };
  }
  if (name === "fix") {
    return {
      maxTokens: 4096,
      system: FIX_SYSTEM,
      user: quoted,
    };
  }
  if (name === "todo") {
    return {
      maxTokens: 1500,
      system: TODO_SYSTEM,
      user: quoted,
    };
  }
  if (name === "ask") {
    if (!String(source).trim()) {
      return {
        maxTokens: 3000,
        system: ASK_PLAIN_SYSTEM,
        user: String(args),
      };
    }
    const question = args || "I don't know how to respond to this message. What should I say?";
    return {
      maxTokens: 3000, // thinking also uses this budget
      system: ASK_ABOUT_MESSAGE_SYSTEM,
      user: `Message:\n${quoted}\n\nMy question: ${question}`,
    };
  }
  return null;
}

async function runLlm(env, system, user, maxTokens, opts = {}) {
  if (!env.AI) throw new Error("Workers AI binding 'AI' is missing");
  const { thinking = false, timeoutSec, temperature = 0.3 } = opts;
  const model = cfg(env, "LLM_MODEL") || "@cf/google/gemma-4-26b-a4b-it";
  const inputs = {
    messages: [
      { role: "system", content: system },
      ...(Array.isArray(user) ? user : [{ role: "user", content: user }]),
    ],
    temperature,
    max_tokens: maxTokens,
  };
  if (model.includes("gemma-4")) inputs.chat_template_kwargs = { enable_thinking: thinking };

  const seconds = timeoutSec ?? (Number(cfg(env, "LLM_TIMEOUT_SEC")) || 40);
  const out = await withTimeout(env.AI.run(model, inputs), seconds * 1000, "LLM");
  let text = String(out?.choices?.[0]?.message?.content ?? out?.response ?? "");
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); // drop the model's reasoning if it leaks into the text
  return { text, model: model.split("/").pop() };
}

async function runTextTask(env, name, args, input) {
  const max = Number(cfg(env, "TEXT_MAX_INPUT")) || 12000;
  const truncated = input.length > max;
  const body = truncated ? input.slice(0, max) : input;
  const note = truncated ? `\n\n(فقط ${max} نویسه‌ی اول متن پردازش شد)` : "";

  if (name === "tr" || name === "fix") {
    const chunks = body.length > CHUNK_CHARS ? splitChunks(body) : [body];
    const results = await Promise.all(
      chunks.map((c) =>
        name === "fix"
          ? runFix(env, c)
          : runTr(env, args, c).catch((err) => {
              console.error("tr part failed:", err);
              return { text: c, model: "", ok: false };
            })
      )
    );
    const failed = results.filter((r) => r.ok === false).length;
    if (name === "tr" && failed === chunks.length) throw new Error("translation failed");

    const text = results.map((r, i) => keepEdges(chunks[i], r.text)).join("").trim();
    const model = [...new Set(results.map((r) => r.model).filter(Boolean))].join(" + ");
    const warning = name === "fix" ? FIX_WARNING : TR_WARNING;
    const warn = failed
      ? "\n\n" + warning + (chunks.length > 1 ? ` (${failed} از ${chunks.length} بخش)` : "")
      : "";
    return { text: text ? text + warn + note : "", model };
  }

  if (name === "extract" || name === "todo") {
    const r = name === "extract" ? { text: extractEntities(body), model: "" } : await runTodo(env, body);
    return { text: r.text ? r.text + note : "", model: r.model };
  }

  const task = buildTask(env, name, args, body);
  if (!task) throw new Error(`unknown task: ${name}`);
  const { text, model } = await runLlm(env, task.system, task.user, task.maxTokens);
  return { text: text ? text + note : "", model };
}

async function replyTask(env, msg, label, received, run, replyToId = msg.message_id) {
  const chatId = msg.chat.id;
  const ack = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `${received}\n🤖 در حال ${label}...`,
    reply_parameters: { message_id: replyToId },
  });
  try {
    const { text, model } = await run();
    return await showParts(env, chatId, ack?.message_id, text || "نتیجه‌ای تولید نشد.", model, "", replyToId);
  } catch (err) {
    console.error(`${label} failed:`, err);
    const failure = err instanceof FileLimitError ? err.message : "❌ جواب نداد." + errorDetail(env, err);
    await showParts(env, chatId, ack?.message_id, failure, "", "", replyToId);
    return [];
  }
}

function replyTextTask(env, msg, name, args, source, replyToId = msg.message_id) {
  return replyTask(env, msg, TASK_LABEL[name], "📥 متن دریافت شد.", () => runTextTask(env, name, args, source), replyToId);
}

async function guestTextTask(env, msg, qid, cmd) {
  if (cmd.name === "extract") {
    const image = imageMedia(msg.reply_to_message);
    if (image) {
      return guestRun(env, msg, qid, "image-extract", () => runImageExtract(env, image, replyText(env, msg.reply_to_message)));
    }
  }
  const source = replyText(env, msg.reply_to_message);
  if (!source) return; // nothing to work on: silence
  await guestRun(env, msg, qid, cmd.name, () => runTextTask(env, cmd.name, cmd.args, source));
}

/* ---------------- /ask (with conversation memory) ---------------- */



async function askOnce(env, system, user, thinking) {
  if (thinking) {
    try {
      const r = await runLlm(env, system, user, 3000, {
        thinking: true,
        temperature: 0.7,
        timeoutSec: Number(cfg(env, "ASK_THINKING_TIMEOUT_SEC")) || 35,
      });
      if (r.text) return { ...r, model: r.model + " (thinking)" };
    } catch (err) {
      console.error("ask with thinking failed, retrying without:", err);
    }
    return runLlm(env, system, user, 1500, { thinking: false, temperature: 0.7, timeoutSec: 25 });
  }
  return runLlm(env, system, user, 1500, { thinking: false, temperature: 0.7, timeoutSec: 30 });
}

function trimHistory(history) {
  let h = history.slice(-12);
  const size = (x) => x.reduce((s, m) => s + String(m.content).length, 0);
  while (h.length > 2 && size(h) > ASK_HISTORY_CHARS) h = h.slice(2);
  while (h.length && h[0].role !== "user") h = h.slice(1);
  return h;
}

async function runAsk(env, question, source, history) {
  let system, messages;
  if (history && history.length) {
    system = ASK_FOLLOWUP_SYSTEM;
    messages = [...history, { role: "user", content: question || "ادامه بده." }];
  } else {
    const max = Number(cfg(env, "TEXT_MAX_INPUT")) || 12000;
    const task = buildTask(env, "ask", question, String(source || "").slice(0, max));
    system = task.system;
    messages = [{ role: "user", content: task.user }];
  }
  const r = await askOnce(env, system, messages, cfgFlag(env, "ASK_THINKING"));
  return {
    text: r.text,
    model: ASK_MARK + r.model,
    history: r.text ? trimHistory([...messages, { role: "assistant", content: r.text }]) : null,
  };
}

function isAskAnswer(env, m) {
  if (!isFromBot(env, m)) return false;
  const parts = String(m.text || "").split("\n\n");
  return parts.length > 1 && parts[parts.length - 1].startsWith(ASK_MARK);
}

async function askHistoryFor(env, chat, target) {
  if (!target) return null;
  const stored = await loadAskThread(env, chat, target.message_id);
  if (stored?.length) return stored;
  if (!isAskAnswer(env, target)) return null;
  const prev = replyText(env, target);
  return prev
    ? [{ role: "user", content: "(The earlier question is not available.)" }, { role: "assistant", content: prev }]
    : null;
}

async function loadAskThread(env, chat, msgId) {
  if (!env.DB || chat == null || msgId == null) return null;
  try {
    const row = await env.DB
      .prepare("SELECT history FROM ask_threads WHERE chat = ? AND msg = ?")
      .bind(chat, msgId)
      .first();
    return row ? JSON.parse(row.history) : null;
  } catch (err) {
    console.error("loadAskThread failed:", err);
    return null;
  }
}

async function saveAskThread(env, chat, msgIds, history) {
  if (!env.DB || !msgIds.length || !history) return;
  try {
    const json = JSON.stringify(history);
    const now = Date.now();
    await env.DB.batch(
      msgIds.map((id) =>
        env.DB
          .prepare("INSERT OR REPLACE INTO ask_threads (chat, msg, history, at) VALUES (?, ?, ?, ?)")
          .bind(chat, id, json, now)
      )
    );
  } catch (err) {
    console.error("saveAskThread failed:", err);
  }
}

async function privateAsk(env, msg, question, history) {
  const chatId = msg.chat.id;
  const target = msg.reply_to_message;
  if (history === undefined) history = await askHistoryFor(env, chatId, target);
  const source = history ? "" : replyText(env, target);
  if (!history && !source && !question) return; // neither a question nor a message: silence

  const replyToId = !history && source ? target.message_id : msg.message_id;
  const received = history ? "📥 ادامه‌ی گفتگو." : source ? "📥 متن دریافت شد." : "📥 سؤال دریافت شد.";
  let newHistory = null;
  const ids = await replyTask(env, msg, TASK_LABEL.ask, received, async () => {
    const r = await runAsk(env, question, source, history);
    newHistory = r.history;
    return r;
  }, replyToId);
  await saveAskThread(env, chatId, ids, newHistory);
}

async function guestAsk(env, msg, qid, cmd) {
  const target = msg.reply_to_message;
  const history = await askHistoryFor(env, null, target); // Guest answers are not stored: only the answer itself
  const source = history ? "" : replyText(env, target);
  if (!history && !source && !cmd.args) return; // nothing to work on: silence
  await guestRun(env, msg, qid, "ask", () => runAsk(env, cmd.args, source, history));
}

/* ---------------- /sum on a link or a PDF ---------------- */


class LinkError extends Error {} // an expected problem with a page or file; its message is shown as it is

const urlsInText = (t) => String(t || "").match(/\bhttps?:\/\/[^\s<>"\u00AB\u00BB]+|\bwww\.[^\s<>"\u00AB\u00BB]+/gi) || [];

function trimUrlEnd(u) {
  let s = String(u);
  for (;;) {
    const last = s.slice(-1);
    if (/[.,;:!?\]}\u00BB"'\u060C\u061B\u061F]/.test(last)) s = s.slice(0, -1);
    else if (last === ")" && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1);
    else return s;
  }
}

function normalizeUrls(list) {
  const seen = new Set();
  const out = [];
  for (let u of list) {
    u = trimUrlEnd(u);
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try {
      const x = new URL(u);
      if (x.protocol !== "http:" && x.protocol !== "https:") continue;
      u = x.href;
    } catch {
      continue;
    }
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

function messageUrls(m) {
  if (!m) return [];
  const text = String(m.text || m.caption || "");
  const out = [];
  for (const e of m.entities || m.caption_entities || []) {
    if (e.type === "text_link" && e.url) out.push(e.url);
    else if (e.type === "url") out.push(text.substr(e.offset, e.length)); // offsets are UTF-16, like JS strings
  }
  out.push(...urlsInText(text));
  return normalizeUrls(out);
}

function linkTargets(env, m, args) {
  const fromArgs = normalizeUrls(urlsInText(args));
  if (fromArgs.length) return fromArgs;                        // "/sum https://..."
  const urls = messageUrls(m);
  if (!urls.length) return [];
  if (/^(link|لینک)$/i.test(String(args || "").trim())) return urls; // "/sum لینک": the link, even in a long message
  const rest = replyText(env, m).replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "").trim();
  return rest.length < LINK_ONLY_MAX_TEXT ? urls : [];
}

function decodeEntities(s) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", zwnj: "\u200c",
    laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—",
  };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return named[e.toLowerCase()] ?? m;
  });
}

function metaContent(html, names) {
  for (const n of names) {
    const m =
      html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, "i"));
    if (m) return decodeEntities(m[1]).trim();
  }
  return "";
}

function htmlToText(html) {
  let h = String(html || "");
  const title =
    metaContent(h, ["og:title"]) ||
    decodeEntities((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
  const desc = metaContent(h, ["og:description", "description", "twitter:description"]);

  h = h
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, " ");

  const toText = (part) =>
    decodeEntities(
      part
        .replace(/<(nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<li\b[^>]*>/gi, "\n• ")
        .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const main = h.match(/<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i);
  let text = main ? toText(main[2]) : "";
  if (text.length < 500) text = toText((h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] || h);
  return { title, desc, text };
}

async function readBytes(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) { truncated = true; break; }
  }
  try { await reader.cancel(); } catch {}
  const bytes = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= bytes.length) break;
    const part = c.subarray(0, Math.min(c.byteLength, bytes.length - off));
    bytes.set(part, off);
    off += part.byteLength;
  }
  return { bytes, truncated };
}

function sniffCharset(bytes) {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
  return m ? m[1] : "";
}

function isPublicIPv4(address) {
  const octets = String(address).split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIPAddress(address) {
  const value = String(address).toLowerCase();
  if (!value.includes(":")) return isPublicIPv4(value);
  const first = parseInt(value.split(":", 1)[0], 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return false;
  if (value.startsWith("2001:db8:") || /^2001:(?:0|2|10|20):/.test(value) || value.startsWith("2002:") || value.startsWith("3fff:")) return false;
  return true;
}

function validatePageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new LinkError("نشانی لینک معتبر نیست."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkError("فقط لینک‌های HTTP و HTTPS پشتیبانی می‌شوند.");
  if (url.username || url.password) throw new LinkError("لینک دارای نام کاربری یا گذرواژه پذیرفته نیست.");
  if ((url.protocol === "http:" && url.port && url.port !== "80") || (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new LinkError("لینک روی این درگاه پشتیبانی نمی‌شود.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|test|invalid)$/.test(host)) {
    throw new LinkError("برای امنیت، نشانی‌های محلی یا غیرعمومی باز نمی‌شوند.");
  }
  if (host.includes(":") || /^\d+(?:\.\d+){0,3}$/.test(host)) {
    throw new LinkError("برای امنیت، نشانی IP مستقیم باز نمی‌شود.");
  }
  return { url, host };
}

async function assertPublicPageHost(host, deadline) {
  let foundAddress = false;
  for (const type of ["A", "AAAA"]) {
    const left = deadline - Date.now();
    if (left <= 0) throw new LinkError(`سایت در ${PAGE_TIMEOUT_MS / 1000} ثانیه جواب نداد.`);
    let response;
    try {
      const query = new URL("https://cloudflare-dns.com/dns-query");
      query.searchParams.set("name", host);
      query.searchParams.set("type", type);
      response = await fetch(query, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(Math.min(left, 4000)),
      });
    } catch {
      throw new LinkError("نتوانستم مقصد لینک را از نظر ایمنی بررسی کنم.");
    }
    if (!response.ok) throw new LinkError("نتوانستم مقصد لینک را از نظر ایمنی بررسی کنم.");
    const data = await response.json().catch(() => null);
    if (!data || (data.Status !== 0 && data.Status !== 3)) throw new LinkError("نتوانستم مقصد لینک را از نظر ایمنی بررسی کنم.");
    for (const answer of data.Answer || []) {
      if (answer.type !== 1 && answer.type !== 28) continue;
      foundAddress = true;
      if (!isPublicIPAddress(answer.data)) throw new LinkError("برای امنیت، لینک‌هایی که به نشانی غیرعمومی می‌رسند باز نمی‌شوند.");
    }
  }
  if (!foundAddress) throw new LinkError("نشانی لینک به یک میزبان عمومی معتبر resolve نشد.");
}

async function fetchPage(url) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  let current = url;
  let res;
  let finalUrl;
  for (let redirects = 0; ; redirects++) {
    const checked = validatePageUrl(current);
    await assertPublicPageHost(checked.host, deadline);
    const left = deadline - Date.now();
    if (left <= 0) throw new LinkError(`سایت در ${PAGE_TIMEOUT_MS / 1000} ثانیه جواب نداد.`);
    res = await fetch(checked.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(left),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "fa,en;q=0.8",
      },
    });
    finalUrl = checked.url.href;
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    if (redirects >= 5) throw new LinkError("این لینک بیش از حد تغییر مسیر می‌دهد.");
    const location = res.headers.get("location");
    if (!location) throw new LinkError("سایت مقصد تغییر مسیر نامعتبر فرستاد.");
    try { current = new URL(location, checked.url).href; }
    catch { throw new LinkError("سایت مقصد تغییر مسیر نامعتبر فرستاد."); }
  }
  if (!res.ok) throw new LinkError(`سایت جواب نداد (کد ${res.status}).`);
  const type = (res.headers.get("content-type") || "").toLowerCase();

  const isPdf = type.includes("application/pdf") || (/octet-stream/.test(type) && /\.pdf(?:$|[?#])/i.test(finalUrl));
  if (isPdf) {
    const { bytes, truncated } = await readBytes(res, PDF_MAX_BYTES);
    if (truncated) throw new LinkError("فایل PDF بزرگ‌تر از ۱۴ مگابایت است.");
    return { pdf: bytes, url: finalUrl, title: "", desc: "", text: "" };
  }

  if (!/text\/html|application\/xhtml|text\/plain/.test(type)) {
    throw new LinkError(`این لینک صفحه‌ی متنی یا PDF نیست (${type.split(";")[0] || "نوع نامشخص"}).`);
  }
  const { bytes } = await readBytes(res, PAGE_MAX_BYTES);
  const charset = (type.match(/charset=["']?([\w-]+)/) || [])[1] || sniffCharset(bytes);
  let dec;
  try { dec = new TextDecoder(charset || "utf-8"); } catch { dec = new TextDecoder(); }
  const raw = dec.decode(bytes);
  const page = type.includes("text/plain") ? { title: "", desc: "", text: raw.trim() } : htmlToText(raw);
  return { ...page, url: finalUrl };
}

function linkErrorText(err) {
  if (err instanceof LinkError) return err.message;
  if (err?.name === "TimeoutError" || /timed? ?out/i.test(String(err?.message))) {
    return `سایت در ${PAGE_TIMEOUT_MS / 1000} ثانیه جواب نداد.`;
  }
  return "دسترسی به سایت ممکن نشد.";
}

async function summarizePdf(env, data) {
  if (data.byteLength > GEMINI_INLINE_MAX) throw new LinkError("فایل PDF بزرگ‌تر از ۱۴ مگابایت است.");
  const lang = cfg(env, "SUMMARY_LANG") || "Persian";
  const prompt = pdfSummaryPrompt(lang);
  const parts = [{ text: prompt }, { inline_data: { mime_type: "application/pdf", data: toBase64(data) } }];
  const timeoutMs = (Number(cfg(env, "PDF_TIMEOUT_SEC")) || 45) * 1000;

  const reasons = [];
  for (const model of geminiModels(env).filter((m) => !m.startsWith("gemini-3.5-transcribe"))) {
    try {
      const text = (await geminiGenerate(env, model, parts, timeoutMs)).trim();
      if (text) return { text, model };
      reasons.push(`${model}: empty`);
    } catch (err) {
      console.error(`${model} PDF failed:`, err);
      reasons.push(`${model}: ${String(err.message).slice(0, 200)}`);
    }
  }
  throw new Error("PDF: " + reasons.join(" ; "));
}

async function runLinkSummary(env, urls) {
  const url = urls[0];
  const more = urls.length > 1 ? `\n\n(از ${toFaDigits(urls.length)} لینک، فقط لینک اول خلاصه شد)` : "";

  let page;
  try {
    page = await fetchPage(url);
  } catch (err) {
    console.error("fetchPage failed:", err);
    return { text: `⚠️ ${linkErrorText(err)}\n${url}`, model: "" };
  }

  if (page.pdf) {
    try {
      const r = await summarizePdf(env, page.pdf);
      return { text: `📄 ${page.url}\n\n${r.text}${more}`, model: r.model };
    } catch (err) {
      console.error("pdf summary failed:", err);
      const why = err instanceof LinkError ? err.message : "خلاصه‌ی PDF ممکن نشد.";
      return { text: `⚠️ ${why}\n${page.url}` + errorDetail(env, err), model: "" };
    }
  }

  const body = [page.desc, page.text].filter(Boolean).join("\n\n");
  if (body.replace(/\s/g, "").length < 150) {
    return {
      text: `⚠️ محتوای قابل‌خواندنی در این صفحه پیدا نشد (احتمالاً صفحه با جاوااسکریپت ساخته می‌شود یا ورود لازم دارد).\n${page.url}`,
      model: "",
    };
  }

  const max = Number(cfg(env, "TEXT_MAX_INPUT")) || 12000;
  const lang = cfg(env, "SUMMARY_LANG") || "Persian";
  const system = linkSummarySystem(lang);
  const user =
    `Title: ${page.title || "-"}\nURL: ${page.url}\n\n` +
    `"""\n${body.slice(0, max).replaceAll('"""', "'''")}\n"""`;

  const r = await runLlm(env, system, user, 1200);
  const header = "🔗 " + (page.title ? clip(page.title, 150) + "\n" : "") + page.url;
  return { text: r.text ? `${header}\n\n${r.text}${more}` : "", model: r.model };
}

async function runPdfFileSummary(env, doc) {
  const name = doc.file_name || "PDF";
  if ((doc.file_size || 0) > GEMINI_INLINE_MAX) {
    return { text: `⚠️ فایل PDF بزرگ‌تر از ۱۴ مگابایت است.\n📄 ${name}`, model: "" };
  }
  const { buffer } = await downloadFile(env, doc.file_id, 30000, GEMINI_INLINE_MAX);
  const r = await summarizePdf(env, buffer);
  return { text: `📄 ${name}\n\n${r.text}`, model: r.model };
}

/* ---------------- Text utilities: normalizer, /extract, /tr, /fix, /todo ---------------- */

const toLatinDigits = (s) =>
  String(s)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
const toFaDigits = (s) => String(s).replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
const isDigitChar = (c) => !!c && /[0-9\u06F0-\u06F9\u0660-\u0669]/.test(c);

function normalizeLetters(text) {
  return String(text || "")
    .replace(/[\u064A\u0649]/g, "\u06CC")  // ي ى -> ی
    .replace(/\u0643/g, "\u06A9")          // ك -> ک
    .replace(/\u0640/g, "")                // tatweel
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(0x06f0 + (d.charCodeAt(0) - 0x0660)));
}

function normalizeText(text) {
  let t = normalizeLetters(text).replace(/[ \t]{2,}/g, " ");
  if (/[\u0600-\u06FF]/.test(t)) {
    t = t
      .replace(/[ \t]+([\u060C\u061B\u061F])/g, "$1")                                    // no space before ، ؛ ؟
      .replace(/([\u060C\u061B\u061F])(?=[\u0600-\u06FFA-Za-z0-9])/g, (mark, _p, off, s) =>
        isDigitChar(s[off - 1]) && isDigitChar(s[off + 1]) ? mark : mark + " ")
      .replace(/(?<![\u0600-\u06FF\u200c])(ن?می)[ \t]+(?=[\u0600-\u06FF])/g, "$1\u200c")  // می‌روم، نمی‌دانم
      .replace(/(?<=[\u0600-\u06FF])[ \t]+(های)(?![\u0600-\u06FF])/g, "\u200c$1");      // کتاب‌های
  }
  return t;
}

function extractTag(raw, tag) {
  const text = String(raw || "").trim();
  const closed = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  if (closed) return closed[1].trim();
  const open = text.match(new RegExp(`<${tag}>([\\s\\S]*)$`, "i"));
  return (open ? open[1] : text).trim();
}

function lengthLooksRight(a, b) {
  if (!b) return false;
  if (a.length < 20) return b.length <= a.length * 3 + 20;
  const ratio = b.length / a.length;
  return ratio > 0.6 && ratio < 1.5;
}

function extractEntities(text) {
  let rest = toLatinDigits(String(text || ""));
  const found = {};
  const take = (key, re, clean = (s) => s.trim()) => {
    const out = [];
    rest = rest.replace(re, (m) => {
      const v = clean(m);
      if (v) out.push(v);
      return " ".repeat(m.length);
    });
    if (out.length) found[key] = [...new Set(out)];
  };
  const trimEnd = (s) => s.replace(/[.,;:!?\u060C\u061B\u061F)\]}\u00BB"']+$/g, "");

  take("links", /\b(?:https?:\/\/|www\.)[^\s<>"\u00AB\u00BB]+|\b(?:t\.me|wa\.me|instagram\.com|youtu\.be)\/[^\s<>"\u00AB\u00BB]+/gi, trimUrlEnd);
  take("emails", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, trimEnd);
  take("usernames", /(?<![\w@.])@[A-Za-z]\w{3,31}/g);
  take("sheba", /\bIR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}\b/gi, (s) => s.replace(/\s+/g, "").toUpperCase());
  take("cards", /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)/g, (s) => s.replace(/[\s-]/g, "").replace(/(\d{4})(?=\d)/g, "$1 "));
  take(
    "phones",
    /(?<!\d)(?:(?:\+|00)98[\s-]?|0)?9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)|(?<!\d)0[1-8]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)|(?<!\d)\+\d{1,3}[\s-]?\d[\d\s-]{7,13}\d/g,
    (s) => s.replace(/[\s-]/g, "")
  );

  take(
    "dates",
    new RegExp(
      String.raw`(?<!\d)(?:1[34]\d{2}|20\d{2})[\/.-]\d{1,2}[\/.-]\d{1,2}(?!\d)` +
        String.raw`|(?<!\d)\d{1,2}[\/.-]\d{1,2}[\/.-](?:1[34]\d{2}|20\d{2})(?!\d)` +
        String.raw`|(?<!\d)\d{1,2}\s*(?:${J_MONTH_ALT})(?![\u0600-\u06FF])(?:\s*1[34]\d{2})?` +
        String.raw`|(?<![\u0600-\u06FF])(?:امروز|فردا|پس[ \u200c]?فردا|دیروز|پریروز|(?:یک|دو|سه|چهار|پنج)[ \u200c]?شنبه|شنبه|جمعه)(?![\u0600-\u06FF])`,
      "g"
    )
  );
  take(
    "times",
    /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?!\d)|ساعت\s*\d{1,2}(?:\s*و\s*(?:نیم|ربع)|:\d{2})?(?:\s*(?:صبح|ظهر|بعدازظهر|عصر|شب))?(?![\u0600-\u06FF\d])|(?<!\d)\d{1,2}\s*(?:صبح|ظهر|عصر|شب)(?![\u0600-\u06FF])/g
  );
  const CUR = "تومان|تومن|ریال|دلار|یورو|درهم|پوند|usd|eur|irr|toman|rial";
  const NUM = String.raw`\d+(?:[,\u066C]\d{3})*(?:\.\d+)?`;
  take(
    "money",
    new RegExp(
      String.raw`(?<![\d.,])${NUM}\s*(?:هزار|میلیون|میلیارد)?\s*(?:${CUR})(?![\u0600-\u06FFA-Za-z])` +
        String.raw`|(?<![\d.,])${NUM}\s*(?:هزار|میلیون|میلیارد)(?![\u0600-\u06FF])` +
        String.raw`|[$€£]\s?${NUM}`,
      "gi"
    )
  );

  const LABELS = [
    ["links", "🔗 لینک‌ها"], ["emails", "📧 ایمیل‌ها"], ["usernames", "👤 آیدی‌ها"],
    ["phones", "📞 شماره‌ها"], ["cards", "💳 کارت‌ها"], ["sheba", "🏦 شبا"],
    ["dates", "📅 تاریخ‌ها"], ["times", "🕒 ساعت‌ها"], ["money", "💰 مبالغ"],
  ];
  const blocks = LABELS.filter(([k]) => found[k]).map(
    ([k, label]) => `${label}\n${found[k].map((v) => "• " + v).join("\n")}`
  );
  return blocks.length ? blocks.join("\n\n") : "چیزی پیدا نشد.";
}

async function runImageExtract(env, media, caption = "") {
  if (media.file_size && media.file_size > MAX_FILE_BYTES) return { text: "⚠️ عکس بزرگ‌تر از ۲۰ مگابایت است.", model: "" };
  const { buffer } = await downloadFile(env, media.file_id, 20000, GEMINI_INLINE_MAX);

  const mime = ["image/jpeg", "image/png", "image/webp"].includes(media.mime_type) ? media.mime_type : "image/jpeg";
  const captionText = String(caption || "").trim();
  const prompt = captionText
    ? `${IMAGE_EXTRACT_PROMPT}\n\nCaption (untrusted text):\n"""\n${captionText.replaceAll('"""', "'''")}\n"""`
    : IMAGE_EXTRACT_PROMPT;
  const parts = [{ text: prompt }, { inline_data: { mime_type: mime, data: toBase64(buffer) } }];
  const models = geminiModels(env).filter((model) => !model.startsWith("gemini-3.5-transcribe"));
  if (!models.length) throw new Error("مدل بینایی Gemini تنظیم نشده است.");

  const timeoutMs = (Number(cfg(env, "PDF_TIMEOUT_SEC")) || 45) * 1000;
  const reasons = [];
  for (const model of models) {
    try {
      const text = (await geminiGenerate(env, model, parts, timeoutMs)).trim();
      if (text) return { text, model };
      reasons.push(`${model}: empty response`);
    } catch (err) {
      console.error(`${model} image extract failed:`, err);
      reasons.push(`${model}: ${String(err.message).slice(0, 200)}`);
    }
  }
  throw new Error("Image extraction failed: " + reasons.join(" ; "));
}

async function runSmart(env, { system, user, maxTokens = 2000, thinking = false, temperature = 0.2 }) {
  if (thinking) {
    try {
      const r = await runLlm(env, system, user, maxTokens + 2000, {
        thinking: true,
        temperature,
        timeoutSec: Number(cfg(env, "ASK_THINKING_TIMEOUT_SEC")) || 35,
      });
      if (r.text) return r;
    } catch (err) {
      console.error("thinking run failed, retrying without:", err);
    }
    return runLlm(env, system, user, maxTokens, { thinking: false, temperature, timeoutSec: 25 });
  }
  return runLlm(env, system, user, maxTokens, { thinking: false, temperature });
}

async function runTr(env, args, input) {
  const task = buildTask(env, "tr", args, input);
  const r = await runLlm(env, task.system, task.user, task.maxTokens);
  if (!r.text) throw new Error("empty translation");
  return { ...r, ok: true };
}

async function runFix(env, input) {
  const normalized = normalizeText(input);
  const task = buildTask(env, "fix", "", normalized);
  try {
    const r = await runSmart(env, {
      system: task.system,
      user: task.user,
      maxTokens: task.maxTokens,
      thinking: cfgFlag(env, "FIX_THINKING"),
      temperature: 0.1,
    });
    const fixed = normalizeLetters(extractTag(r.text, "fixed"));
    if (fixed && lengthLooksRight(normalized, fixed)) return { text: fixed, model: r.model, ok: true };
    console.error("fix: model output rejected");
  } catch (err) {
    console.error("fix failed:", err);
  }
  return { text: normalized, model: "normalizer", ok: false };
}

async function runTodo(env, input) {
  const task = buildTask(env, "todo", "", input);
  const r = await runSmart(env, {
    system: task.system,
    user: task.user,
    maxTokens: task.maxTokens,
    temperature: 0.2,
  });
  return { text: r.text, model: r.model };
}

/* ---------------- Reminders: /remind /reminders /unremind (+ Cron Trigger, snooze buttons) ---------------- */

const shortId = (id) => String(id).slice(0, SHORT_ID_LEN);
const pad2 = (n) => String(n).padStart(2, "0");


const db = (env) => {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  return env.DB;
};

function gregorianToJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

function jalaliToGregorian(jy, jm, jd) {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const sal = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm;
  for (gm = 0; gm < 13 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}

function jalaliMonthDays(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  const g = jalaliToGregorian(jy, 12, 30);
  const back = gregorianToJalali(g[0], g[1], g[2]);
  return back[1] === 12 && back[2] === 30 ? 30 : 29;
}

function nextJalaliDay(day, jy, jm, minDay = 1) {
  for (let i = 0; i < 13; i++) {
    if (day <= jalaliMonthDays(jy, jm) && (i > 0 || day >= minDay)) return [jy, jm];
    if (++jm > 12) { jm = 1; jy++; }
  }
  return null;
}

function jalaliAt(jy, jm, jd, H, M) {
  const g = jalaliToGregorian(jy, jm, jd);
  return Date.UTC(g[0], g[1] - 1, g[2], H, M) - TEHRAN_OFFSET_MS;
}

function tehranNow(ms = Date.now()) {
  const t = new Date(ms + TEHRAN_OFFSET_MS);
  const gy = t.getUTCFullYear(), gm = t.getUTCMonth() + 1, gd = t.getUTCDate();
  const [jy, jm, jd] = gregorianToJalali(gy, gm, gd);
  return { ms, gy, gm, gd, H: t.getUTCHours(), M: t.getUTCMinutes(), dow: t.getUTCDay(), jy, jm, jd };
}

function formatTehran(ms) {
  const n = tehranNow(ms);
  return toFaDigits(`${DOW_FA[n.dow]} ${n.jd} ${J_MONTHS[n.jm - 1]} ${n.jy}، ساعت ${pad2(n.H)}:${pad2(n.M)}`);
}

function parseHM(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const H = Number(m[1]), M = Number(m[2]);
  return H < 24 && M < 60 ? { H, M } : null;
}

function guessAmPm(hm, spec) {
  if (!hm || spec.ampm_explicit || hm.H < 1 || hm.H > 6) return hm;
  return { H: hm.H + 12, M: hm.M };
}

/* --- repeating reminders --- */

function makeRepeat(kind, at, spec) {
  const t = tehranNow(at);
  if (kind === "monthly") return `monthly:${t.jd}`;
  if (kind === "yearly") {
    return spec.date?.calendar === "gregorian" ? `yearly:g:${t.gm}-${t.gd}` : `yearly:j:${t.jm}-${t.jd}`;
  }
  return kind; // daily, weekly
}

function nextOccurrence(at, repeat) {
  const [kind, a, b] = String(repeat || "").split(":");
  if (kind === "daily") return at + DAY_MS;   // Tehran has no daylight saving, so a day is always 24h
  if (kind === "weekly") return at + 7 * DAY_MS;
  const t = tehranNow(at);
  if (kind === "monthly") {
    let jy = t.jy, jm = t.jm + 1;
    if (jm > 12) { jm = 1; jy++; }
    return jalaliAt(jy, jm, Math.min(Number(a) || t.jd, jalaliMonthDays(jy, jm)), t.H, t.M);
  }
  if (kind === "yearly") {
    const [mm, dd] = String(b || "").split("-").map(Number);
    if (!mm || !dd) return null;
    if (a === "g") {
      const gy = t.gy + 1;
      const dim = new Date(Date.UTC(gy, mm, 0)).getUTCDate(); // days in that month
      return Date.UTC(gy, mm - 1, Math.min(dd, dim), t.H, t.M) - TEHRAN_OFFSET_MS;
    }
    const jy = t.jy + 1;
    return jalaliAt(jy, mm, Math.min(dd, jalaliMonthDays(jy, mm)), t.H, t.M);
  }
  return null;
}

function nextAfter(at, repeat, after) {
  let t = at;
  for (let i = 0; i < 1000 && t != null && t <= after; i++) t = nextOccurrence(t, repeat);
  return t != null && t > after ? t : null;
}

function repeatLabel(repeat, at) {
  const [kind, a, b] = String(repeat || "").split(":");
  const t = tehranNow(at);
  if (kind === "daily") return "هر روز";
  if (kind === "weekly") return `هر ${DOW_FA[t.dow]}`;
  if (kind === "monthly") return toFaDigits(`هر ماه، روز ${a || t.jd}`);
  if (kind === "yearly") {
    const [mm, dd] = String(b || "").split("-").map(Number);
    return toFaDigits(a === "g" ? `هر سال، ${dd} ${G_MONTHS_FA[mm - 1]}` : `هر سال، ${dd} ${J_MONTHS[mm - 1]}`);
  }
  return "";
}

async function parseReminderSpec(env, request) {
  const n = tehranNow();
  const system = reminderSpecSystem(
    `${n.gy}-${pad2(n.gm)}-${pad2(n.gd)} ${pad2(n.H)}:${pad2(n.M)} (${DOW_EN[n.dow]})`,
    `${n.jy}/${n.jm}/${n.jd}`
  );
  const r = await runSmart(env, {
    system,
    user: `Request:\n"""\n${String(request).replaceAll('"""', "'''")}\n"""`,
    maxTokens: 700,
    temperature: 0,
  });
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in the model reply");
  return JSON.parse(m[0]);
}

const jMonthNumber = (name) => {
  for (const [forms, num] of J_MONTH_FORMS) if (new RegExp(`^(?:${forms})$`).test(String(name))) return Number(num);
  return 0;
};

function fixSpecFromText(spec, request) {
  if (!spec || typeof spec !== "object") return spec;
  const t = toLatinDigits(normalizeLetters(request)).replace(/\u200c/g, " ");
  const notLetter = String.raw`(?![\u0600-\u06FF])`;

  let day = 0, month = 0, year = null;
  let m = t.match(new RegExp(String.raw`(?<![\d:./])(\d{1,2})\s*(?:ام|م)?\s*(${J_MONTH_ALT})${notLetter}(?:\s*(?:ماه)?\s*(1[34]\d{2})(?!\d))?`));
  if (m) {
    day = Number(m[1]); month = jMonthNumber(m[2]); year = m[3] ? Number(m[3]) : null;
  } else {
    m = t.match(new RegExp(String.raw`(?<![\u0600-\u06FF])(${J_MONTH_ALT})${notLetter}\s*(?:ماه)?\s*(\d{1,2})(?![\d:])`));
    if (m) { month = jMonthNumber(m[1]); day = Number(m[2]); }
  }
  if (!month || day < 1 || day > 31) return spec;

  spec.date = { calendar: "jalali", year, month, day };
  spec.in = null;   // the model may have turned the same words into a duration
  spec.day = null;  // and into "today / tomorrow"
  return spec;
}

function computeReminderAt(spec, n) {
  if (!spec || typeof spec !== "object") return { error: "زمان مشخص نشد." };
  if (spec.repeat === "unsupported") {
    return { error: "فقط تکرار روزانه، هفتگی، ماهانه و سالانه پشتیبانی می‌شه." };
  }
  const MIN = 60000;
  const tooFar = { error: "یادآوری بیشتر از یک سال بعد پشتیبانی نمی‌شه." };
  const past = { error: "این زمان گذشته است." };
  const soon = n.ms + 30000;
  const kind = REPEAT_KINDS.has(spec.repeat) ? spec.repeat : null;

  if (!kind && spec.in && typeof spec.in === "object") {
    const mins =
      (Number(spec.in.minutes) || 0) + 60 * (Number(spec.in.hours) || 0) +
      1440 * (Number(spec.in.days) || 0) + 10080 * (Number(spec.in.weeks) || 0);
    const months = (Number(spec.in.months) || 0) + 12 * (Number(spec.in.years) || 0);
    if (mins > 0 || months > 0) {
      let base = n.ms;
      if (months > 0) {
        const idx = n.jm - 1 + months;
        const jy = n.jy + Math.floor(idx / 12), jm = (idx % 12) + 1;
        base = jalaliAt(jy, jm, Math.min(n.jd, jalaliMonthDays(jy, jm)), n.H, n.M);
      }
      let at = base + mins * MIN;

      const hm = parseHM(spec.time);
      const wholeDays = !(Number(spec.in.minutes) || 0) && !(Number(spec.in.hours) || 0);
      if (hm && wholeDays) {
        const t = guessAmPm(hm, spec);
        const d = new Date(at + TEHRAN_OFFSET_MS);
        at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), t.H, t.M) - TEHRAN_OFFSET_MS;
      }
      if (at <= soon) return past;
      if (at - n.ms > MAX_AHEAD_MS) return tooFar;
      return { at, repeat: null };
    }
  }

  let date = spec.date;
  let dayOnly = 0;
  if (date && Number(date.day) && !Number(date.month)) {
    dayOnly = Number(date.day);
    const f = nextJalaliDay(dayOnly, n.jy, n.jm, n.jd);
    if (!f) return { error: "تاریخ نامعتبر است." };
    date = { calendar: "jalali", year: f[0], month: f[1], day: dayOnly };
  }

  let time = parseHM(spec.time);
  let [y, m, d] = [n.gy, n.gm, n.gd];
  let explicit = false;
  let weekdayMode = false;

  if (date && Number(date.month) && Number(date.day)) {
    const month = Number(date.month), day = Number(date.day);
    if (month < 1 || month > 12 || day < 1 || day > 31) return { error: "تاریخ نامعتبر است." };
    const jalali = date.calendar !== "gregorian";
    let year = Number(date.year) || null;
    if (year && year < 100) year += jalali ? 1400 : 2000;

    const toG = (yy) => {
      if (jalali) {
        const g = jalaliToGregorian(yy, month, day);
        const back = gregorianToJalali(g[0], g[1], g[2]);
        return back[0] === yy && back[1] === month && back[2] === day ? g : null;
      }
      const dt = new Date(Date.UTC(yy, month - 1, day));
      return dt.getUTCFullYear() === yy && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day ? [yy, month, day] : null;
    };

    const todayUTC = Date.UTC(n.gy, n.gm - 1, n.gd);
    const baseYear = year || (jalali ? n.jy : n.gy);
    let g = null;
    for (let i = 0; i < (year ? 1 : 5) && !g; i++) {
      const c = toG(baseYear + i);
      if (!c) continue;
      if (!year && Date.UTC(c[0], c[1] - 1, c[2]) < todayUTC) continue;
      g = c;
    }
    if (!g) return { error: "تاریخ نامعتبر است." };
    [y, m, d] = g;
    explicit = true;
  } else if (Object.prototype.hasOwnProperty.call(WEEKDAY_KEYS, spec.weekday)) {
    const delta = (WEEKDAY_KEYS[spec.weekday] - n.dow + 7) % 7;
    const t = new Date(Date.UTC(n.gy, n.gm - 1, n.gd + delta));
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
    explicit = true;
    weekdayMode = true;
  } else if (spec.day === "today" || spec.day === "tomorrow" || spec.day === "day_after") {
    const add = { today: 0, tomorrow: 1, day_after: 2 }[spec.day];
    const t = new Date(Date.UTC(n.gy, n.gm - 1, n.gd + add));
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
    explicit = true;
  }

  if (!time) {
    if (!explicit && !kind) return { error: "زمان مشخص نشد." };
    time = { H: 9, M: 0 }; // a day (or a repeat) without an hour: 09:00
  }
  if (kind) time = guessAmPm(time, spec);

  const build = (yy, mm, dd, t = time) => Date.UTC(yy, mm - 1, dd, t.H, t.M) - TEHRAN_OFFSET_MS;
  const isToday = y === n.gy && m === n.gm && d === n.gd;
  let at;

  if (!isToday) {
    at = build(y, m, d, kind ? time : guessAmPm(time, spec));
  } else {
    at = build(y, m, d);
    if (!kind && at <= soon && !spec.ampm_explicit && time.H >= 1 && time.H < 12) {
      const pm = build(y, m, d, { H: time.H + 12, M: time.M }); // maybe the afternoon was meant
      if (pm > soon) at = pm;
    }
    if (!kind && at <= soon) {
      if (!explicit) at = build(y, m, d + 1, guessAmPm(time, spec));        // only an hour: tomorrow
      else if (weekdayMode) at = build(y, m, d + 7, guessAmPm(time, spec)); // same weekday next week
    }
  }

  if (!kind && dayOnly && at <= soon) {
    const [jy, jm] = n.jm === 12 ? [n.jy + 1, 1] : [n.jy, n.jm + 1];
    const f = nextJalaliDay(dayOnly, jy, jm);
    if (f) {
      const t = guessAmPm(time, spec);
      at = jalaliAt(f[0], f[1], dayOnly, t.H, t.M);
    }
  }

  let repeat = null;
  if (kind) {
    repeat = makeRepeat(kind, at, spec);          // anchored on the first computed occurrence
    if (at <= soon) at = nextAfter(at, repeat, soon); // already passed today: the next occurrence
    if (!at) return { error: "زمان مشخص نشد." };
  }
  if (at <= soon) return past; // e.g. a date with a year that is already over
  if (at - n.ms > MAX_AHEAD_MS) return tooFar;
  return { at, repeat };
}

async function insertReminder(env, chatId, at, text, replyId, repeat) {
  const row = await db(env).prepare("SELECT COUNT(*) AS n FROM reminders WHERE chat = ?").bind(chatId).first();
  if ((row?.n || 0) >= MAX_REMINDERS) {
    return { ok: false, error: `⚠️ حداکثر ${MAX_REMINDERS} یادآوری فعال می‌تونی داشته باشی. با /reminders ببین و حذف کن.` };
  }
  const id = crypto.randomUUID();
  await db(env)
    .prepare("INSERT INTO reminders (id, chat, at, text, reply, repeat, tries) VALUES (?, ?, ?, ?, ?, ?, 0)")
    .bind(id, chatId, at, text, replyId || null, repeat || null)
    .run();
  return { ok: true, id };
}

async function createReminder(env, chatId, args, replied, replyId) {
  let spec;
  try {
    spec = await parseReminderSpec(env, args);
    spec = fixSpecFromText(spec, args); // a Persian month name always means the Jalali calendar
  } catch (err) {
    console.error("parseReminderSpec failed:", err);
    return { ok: false, text: "❌ زمان رو نتونستم تشخیص بدم.\nمثال: /remind فردا ۹ صبح" + errorDetail(env, err) };
  }
  const res = computeReminderAt(spec, tehranNow());
  if (res.error) {
    return { ok: false, text: "⚠️ " + res.error + "\nمثال: /remind فردا ۹ صبح  یا  /remind ۲ ساعت دیگه  یا  /remind هر روز ساعت ۹" };
  }

  const own = String(spec.text || "").trim();
  let text = own;
  if (replied && (!own || !replyId)) text = own ? own + "\n\n↩️ " + replied : replied;
  text = clip(text, 700);
  if (!text) {
    return { ok: false, text: "⚠️ موضوع یادآوری مشخص نیست. بعد از زمان موضوع رو بنویس یا روی یه پیام ریپلای کن." };
  }

  const ins = await insertReminder(env, chatId, res.at, text, replyId, res.repeat);
  if (!ins.ok) return { ok: false, text: ins.error };

  const when = res.repeat
    ? `🔁 ${repeatLabel(res.repeat, res.at)}\nاولین بار: ${formatTehran(res.at)} (وقت تهران)`
    : `${formatTehran(res.at)} (وقت تهران)`;
  return {
    ok: true,
    text: `⏰ یادآوری ثبت شد:\n${when}\n«${clip(text.replace(/\s+/g, " "), 120)}»\nکد: ${shortId(ins.id)}`,
  };
}

async function replyRemind(env, msg, args) {
  const chatId = msg.chat.id;
  if (!args) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "زمان رو بنویس. مثال:\n/remind فردا ۹ صبح\n/remind ۲ ساعت دیگه زنگ بزنم به علی\n/remind هر روز ساعت ۹ قرص\nیا روی یه پیام ریپلای کن و بنویس /remind شنبه ساعت ۱۰",
    });
    return;
  }
  const replied = replyText(env, msg.reply_to_message);
  const replyId = replied ? msg.reply_to_message.message_id : null;
  const ack = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "⏰ در حال تشخیص زمان...",
    reply_parameters: { message_id: msg.message_id },
  });
  let out;
  try {
    out = (await createReminder(env, chatId, args, replied, replyId)).text;
  } catch (err) {
    console.error("remind failed:", err);
    out = "❌ ثبت نشد." + errorDetail(env, err);
  }
  if (ack?.message_id && (await tg(env, "editMessageText", { chat_id: chatId, message_id: ack.message_id, text: out }))) return;
  await tg(env, "sendMessage", { chat_id: chatId, text: out });
}

async function guestRemind(env, msg, qid, cmd) {
  if (!cmd.args) return; // no time given: silence
  const replied = replyText(env, msg.reply_to_message);
  try {
    const r = await createReminder(env, msg.from.id, cmd.args, replied, null);
    await answerGuest(env, qid, r.text);
  } catch (err) {
    console.error("guest remind failed:", err);
    await answerGuest(env, qid, "خطا." + errorDetail(env, err));
  }
}

async function replyReminderList(env, chatId) {
  const { results } = await db(env)
    .prepare("SELECT id, at, text, repeat FROM reminders WHERE chat = ? ORDER BY at")
    .bind(chatId)
    .all();
  if (!results.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⏰ یادآوری فعالی نداری." });
    return;
  }
  const entries = results.map((r, i) => {
    const rep = r.repeat ? ` 🔁 ${repeatLabel(r.repeat, r.at)}` : "";
    return `${i + 1}. [${shortId(r.id)}] ${formatTehran(r.at)}${rep}\n   ${clip(r.text.replace(/\s+/g, " "), 60)}`;
  });
  const footer = "\n\nحذف: /unremind <کد داخل کروشه یا all>";
  const parts = [];
  let cur = "⏰ یادآوری‌ها:\n";
  for (const e of entries) {
    if (cur.length + e.length + 1 > MAX_TEXT - footer.length) { parts.push(cur); cur = ""; }
    cur += "\n" + e;
  }
  parts.push(cur + footer);
  for (const p of parts) await tg(env, "sendMessage", { chat_id: chatId, text: p.trim() });
}

async function replyUnremind(env, chatId, arg) {
  const a = toLatinDigits(String(arg || "")).trim().toLowerCase().replace(/^[#\[]+|\]+$/g, "");

  if (a === "all") {
    const r = await db(env).prepare("DELETE FROM reminders WHERE chat = ?").bind(chatId).run();
    const removed = r.meta?.changes || 0;
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: removed ? `🗑 ${removed} یادآوری حذف شد.` : "⏰ یادآوری فعالی نداری.",
    });
    return;
  }

  if (!/^[0-9a-f-]{4,36}$/.test(a)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ کد یادآوری رو بنویس (همون که توی /reminders داخل کروشه است)، مثلاً /unremind a3f2c1",
    });
    return;
  }

  const { results } = await db(env)
    .prepare("SELECT id FROM reminders WHERE chat = ? AND id LIKE ? LIMIT 2")
    .bind(chatId, a + "%")
    .all();
  if (!results.length) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ یادآوری با این کد پیدا نشد (شاید قبلاً ارسال شده). /reminders رو ببین." });
    return;
  }
  if (results.length > 1) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ این کد با چند یادآوری جور درمیاد؛ چند حرف بیشتر بنویس." });
    return;
  }
  const r = await db(env).prepare("DELETE FROM reminders WHERE id = ? AND chat = ?").bind(results[0].id, chatId).run();
  await tg(env, "sendMessage", { chat_id: chatId, text: `🗑 ${r.meta?.changes || 0} یادآوری حذف شد.` });
}

/* --- snooze buttons --- */

function reminderTextFromMessage(t) {
  const lines = String(t || "").split("\n");
  if (!lines[0].startsWith("⏰")) return "";
  return lines.slice(1).join("\n").replace(/\n\n🔁 [^\n]*$/, "").trim();
}

async function handleCallback(cq, env) {
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text } : {}) });
  if (!isOwner(env, cq.from?.id)) return void (await answer());

  const m = cq.message;
  const data = String(cq.data || "");
  const isSnoozeMinutes = Object.prototype.hasOwnProperty.call(SNOOZE_MINUTES, data);
  if (!m?.chat || !(data === CB_DONE || data === CB_SNOOZE_TOMORROW || isSnoozeMinutes)) return void (await answer());

  const chatId = m.chat.id;
  const original = String(m.text || "");
  let status, toast;

  try {
    if (data === CB_DONE) {
      status = "✅ انجام شد";
      toast = "✅ انجام شد";
    } else {
      const now = Date.now();
      let at;
      if (data === CB_SNOOZE_TOMORROW) {
        const sameTime = m.date * 1000 + DAY_MS;
        at = sameTime > now + 60000 ? sameTime : now + DAY_MS;
      } else {
        at = now + SNOOZE_MINUTES[data] * 60000;
      }
      const text = reminderTextFromMessage(original);
      if (!text) return void (await answer("متن یادآوری پیدا نشد."));
      const ins = await insertReminder(env, chatId, at, text, m.reply_to_message?.message_id || null, null);
      if (!ins.ok) return void (await answer(ins.error.slice(0, 190)));
      status = `💤 به تعویق افتاد تا ${formatTehran(at)}`;
      toast = status;
    }
  } catch (err) {
    console.error("snooze failed:", err);
    return void (await answer("خطا."));
  }

  await tg(env, "editMessageText", { chat_id: chatId, message_id: m.message_id, text: clip(original + "\n\n" + status, 4090) });
  await answer(toast.slice(0, 190));
}

/* --- Cron --- */

async function runDueReminders(env) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("DELETE FROM seen_updates WHERE at < ?").bind(Date.now() - 3600000).run();
  } catch (err) {
    console.error("seen_updates cleanup failed:", err);
  }
  try {
    const days = Number(cfg(env, "ASK_THREAD_DAYS")) || 7;
    await env.DB.prepare("DELETE FROM ask_threads WHERE at < ?").bind(Date.now() - days * DAY_MS).run();
  } catch (err) {
    console.error("ask_threads cleanup failed:", err);
  }

  const now = Date.now();
  const { results: due } = await env.DB
    .prepare(
      `UPDATE reminders SET claimed = ?
       WHERE id IN (
         SELECT id FROM reminders
         WHERE at <= ? AND (claimed IS NULL OR claimed < ?)
         ORDER BY at LIMIT 50
       )
       RETURNING *`
    )
    .bind(now, now, now - 5 * 60000)
    .all();

  due.sort((a, b) => a.at - b.at); // RETURNING does not guarantee an order
  for (const r of due) {
    const late = now - r.at > 5 * 60000;
    const label = r.repeat ? "\n\n🔁 " + repeatLabel(r.repeat, r.at) : "";
    const sent = await tg(env, "sendMessage", {
      chat_id: r.chat,
      text: clip(`⏰ یادآوری${late ? " (با تأخیر)" : ""}:\n${r.text}`, MAX_TEXT - label.length) + label,
      reply_parameters: r.reply ? { message_id: r.reply, allow_sending_without_reply: true } : undefined,
      reply_markup: SNOOZE_KEYBOARD,
    });

    const finished = sent || (r.tries || 0) >= 4 || now - r.at > DAY_MS;
    if (finished) {
      const next = r.repeat ? nextAfter(r.at, r.repeat, now) : null;
      if (next) {
        await env.DB.prepare("UPDATE reminders SET at = ?, tries = 0, claimed = NULL WHERE id = ?").bind(next, r.id).run();
      } else {
        await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(r.id).run();
      }
    } else {
      await env.DB.prepare("UPDATE reminders SET tries = COALESCE(tries, 0) + 1, claimed = NULL WHERE id = ?").bind(r.id).run();
    }
  }
}

/* ---------------- Gemini (speech-to-text and PDFs) ---------------- */

function geminiModels(env) {
  const models = cfgList(env, "GEMINI_MODELS");
  return models.length ? models : cfgList(env, "GEMINI_MODEL");
}

async function geminiGenerate(env, model, parts, timeoutMs) {
  const key = cfg(env, "GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is empty");

  const body = { contents: [{ role: "user", parts }], generationConfig: {} };
  if (!model.startsWith("gemini-3.5-transcribe")) {
    const level = cfg(env, "GEMINI_THINKING_LEVEL");
    if (level) body.generationConfig.thinkingConfig = { thinkingLevel: level, includeThoughts: false };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts || [];
  return out.filter((p) => !p.thought).map((p) => p.text || "").join("");
}

/* ---------------- Speech to text ---------------- */

async function transcribeFileId(env, media, onStatus = async (_text) => {}) {
  const deadline = Date.now() + (Number(cfg(env, "STT_TOTAL_SEC")) || 100) * 1000;
  const mb = (Number(media.file_size) || 0) / (1024 * 1024);
  const downloadMs = clamp(10000 + mb * 1500, 10000, 40000); // ~1.5s per MB, 10–40s

  const { buffer, path } = await downloadFile(env, media.file_id, downloadMs);
  const kb = Math.max(1, Math.round(buffer.byteLength / 1024));
  const first = geminiModels(env)[0] || "Gemini";
  await onStatus(`✅ ویس دانلود شد (${kb} KB).\n📤 ویس به ${first} ارسال شد، منتظر جواب...`);
  return transcribe(env, buffer, path, onStatus, { duration: media.duration, deadline });
}

async function transcribe(env, buffer, filePath, onStatus = async (_text) => {}, opts = {}) {
  const models = geminiModels(env);
  const deadline = opts.deadline || Infinity;
  const left = () => deadline - Date.now();

  let b64 = null;
  const audio = { size: buffer.byteLength, b64: () => (b64 ??= toBase64(buffer)) };

  const duration = Number(opts.duration) || buffer.byteLength / 3000;
  const minS = Number(cfg(env, "GEMINI_TIMEOUT_SEC")) || 25;
  const maxS = Math.max(minS, Number(cfg(env, "GEMINI_TIMEOUT_MAX_SEC")) || 60);
  const geminiMs = clamp(10 + duration * 0.4, minS, maxS) * 1000;
  const whisperMs = clamp(10 + duration * 0.25, 15, 45) * 1000;
  const reasons = [];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const ms = Math.min(geminiMs, left() - WHISPER_RESERVE_MS);
    if (ms < 5000) {
      reasons.push(`${model}: وقت کافی نماند`);
      break;
    }

    let reason;
    const t0 = Date.now();
    try {
      const text = await transcribeGemini(env, audio, filePath, model, ms);
      if (text) return { text, model, reasons };
      reason = "متنی برنگرداند";
    } catch (err) {
      reason = String(err.message);
      console.error(`${model} STT failed:`, err);
    }

    reasons.push(`${model}: ${reason}`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const next = i + 1 < models.length ? models[i + 1] : "Whisper (جایگزین)";
    await onStatus(`⚠️ ${model} جواب نداد (${secs} ثانیه): ${reason.slice(0, 150)}\n🔄 ارسال به ${next}...`);
  }

  try {
    const ms = Math.min(whisperMs, left());
    if (ms < 3000) throw new Error("time budget exhausted");
    return { text: await transcribeWhisper(env, audio.b64(), ms), model: WHISPER_MODEL.split("/").pop(), reasons };
  } catch (err) {
    console.error("Whisper fallback failed:", err);
    await onStatus(`⚠️ Whisper هم جواب نداد: ${String(err.message).slice(0, 150)}`);
    throw new Error(`${reasons.join(" ; ")} ; Whisper: ${err.message}`);
  }
}



function extractTranscript(raw) {
  const text = String(raw || "").trim();
  const closed = text.match(/<transcript>([\s\S]*?)<\/transcript>/i);
  if (closed) return closed[1].trim();
  const open = text.match(/<transcript>([\s\S]*)$/i);
  if (open) return open[1].trim();
  if (/^(the user|let'?s|key speech)/i.test(text) || /\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/.test(text)) {
    throw new Error("model returned reasoning instead of a transcript");
  }
  return text;
}

function guessMime(filePath) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  const map = { oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mp3", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm" };
  return map[ext] || "audio/ogg";
}

async function transcribeGemini(env, audio, filePath, model, timeoutMs) {
  if (audio.size > GEMINI_INLINE_MAX) throw new Error("audio too large for inline Gemini request");
  const parts = [];
  if (!model.startsWith("gemini-3.5-transcribe")) parts.push({ text: GEMINI_PROMPT });
  parts.push({ inline_data: { mime_type: guessMime(filePath), data: audio.b64() } });
  return extractTranscript(await geminiGenerate(env, model, parts, timeoutMs));
}

async function transcribeWhisper(env, audioBase64, timeoutMs = 15000) {
  if (!env.AI) throw new Error("Workers AI binding 'AI' is missing");
  const out = await withTimeout(
    env.AI.run(WHISPER_MODEL, {
      audio: audioBase64,
      language: cfg(env, "LANG") || "fa",
    }),
    timeoutMs,
    "Whisper"
  );
  return (out?.text || "").trim();
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
