export const CONFIG = {
  GEMINI_MODELS: ["gemini-3.6-flash", "gemini-3.5-flash"],
  GEMINI_TIMEOUT_SEC: 25,     // MINIMUM wait for each Gemini model; longer voices get more (up to the max below)
  GEMINI_TIMEOUT_MAX_SEC: 60, // maximum wait for each Gemini model
  STT_TOTAL_SEC: 100,         // total time budget for one transcription (download + all models + Whisper)
  PDF_TIMEOUT_SEC: 45,        // wait for each Gemini model when summarizing a PDF
  GEMINI_THINKING_LEVEL: "low", // only used for general models such as 3.6 Flash ("minimal" is not supported there)
  ADMIN_CHAT_IDS: [],
  STT_MEDIA: ["voice"], // what /stt accepts: any of "voice", "audio", "video_note", "video"
  AUTO_TRANSCRIBE_DIRECT_VOICE: false, // true = a voice sent straight to the bot is transcribed without /stt
  LANG: "fa",   // language hint (used by the Whisper fallback)
  LLM_MODEL: "@cf/google/gemma-4-26b-a4b-it", // Workers AI model for /sum /tr /fix /ask
  LLM_TIMEOUT_SEC: 40,         // how long to wait for it
  ASK_THINKING: true,          // thinking only for /ask
  ASK_THINKING_TIMEOUT_SEC: 35, // if it takes longer, /ask is retried without thinking
  ASK_THREAD_DAYS: 7,          // how long an /ask conversation can be continued
  FIX_THINKING: true,           // thinking for /fix (Gemma; falls back to no thinking if slow)
  TEXT_MAX_INPUT: 12000,       // characters of the replied text (or page text) that are sent to the model
  SUMMARY_LANG: "Persian",     // language of /sum summaries
  DEBUG: "0",
};

/* ---------------- Limits and timing ---------------- */

export const DAY_MS = 86400000;

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // Bot API getFile limit

export const GEMINI_INLINE_MAX = 14 * 1024 * 1024; // base64 inflates ~33%, keeps request under ~20MB

export const MAX_TEXT = 4000;

export const CHUNK_CHARS = 3000; // /tr and /fix: longer inputs are split into parts of about this size

export const WHISPER_RESERVE_MS = 15000; // time kept free for the Whisper fallback while Gemini models are tried

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export const ASK_HISTORY_CHARS = 16000; // an /ask conversation is trimmed (oldest turns first) to about this size

export const PAGE_MAX_BYTES = 3 * 1024 * 1024; // read at most this much of a web page

export const PDF_MAX_BYTES = GEMINI_INLINE_MAX; // a PDF is sent inline to Gemini

export const PAGE_TIMEOUT_MS = 15000;

export const LINK_ONLY_MAX_TEXT = 300; // a message with less text than this (besides its links) counts as "a link"

export const TEHRAN_OFFSET_MS = 3.5 * 3600 * 1000;

export const MAX_REMINDERS = 50; // per chat

export const MAX_AHEAD_MS = 366 * DAY_MS; // reminders at most about a year ahead

export const SHORT_ID_LEN = 6;


/* ---------------- Fixed texts and command lists ---------------- */

export const FIX_WARNING = "⚠️ مدل جواب معتبری نداد؛ فقط اصلاحات ساده اعمال شد.";

export const TR_WARNING = "⚠️ بخشی از متن ترجمه نشد و متن اصلی آن آمده است.";

export const FULL_TEXT_NOTE = "(متن کامل در چت خصوصی با بات فرستاده شد)";

export const ASK_MARK = "💬 "; // starts the model footer of /ask answers, so they can be recognised later

export const COMMANDS = {
  stt:     { on: "voice", description: "تبدیل ویس به متن" },
  sum:     { on: "text", textTask: true, label: "خلاصه‌سازی",     description: "خلاصه‌کردن متن، لینک یا PDF" },
  tr:      { on: "text", textTask: true, label: "ترجمه",          description: "ترجمه‌ی متن" },
  fix:     { on: "text", textTask: true, label: "اصلاح",          description: "اصلاح نگارش" },
  ask:     { on: "text", textTask: true, label: "پاسخ‌دهی",        description: "مشورت درباره‌ی متن یا سؤال آزاد" },
  todo:    { on: "text", textTask: true, label: "استخراج کارها",   description: "استخراج کارها" },
  extract: { on: "text", textTask: true, label: "استخراج اطلاعات", description: "استخراج اطلاعات از متن یا عکس" },
  remind:  { on: "text", description: "یادآوری" },
};

export const TEXT_COMMANDS = new Set(Object.keys(COMMANDS).filter((name) => COMMANDS[name].textTask));

export const TASK_LABEL = Object.fromEntries(
  Object.entries(COMMANDS).filter(([, c]) => c.label).map(([name, c]) => [name, c.label])
);

export const RETRY_SENSITIVE_COMMANDS = [...Object.keys(COMMANDS), "reminders", "unremind"];

export const CB_SNOOZE_10 = "sn:10";
export const CB_SNOOZE_60 = "sn:60";
export const CB_SNOOZE_TOMORROW = "sn:tom"; // tomorrow at the time the reminder arrived
export const CB_DONE = "done";

export const SNOOZE_MINUTES = { [CB_SNOOZE_10]: 10, [CB_SNOOZE_60]: 60 };

export const SNOOZE_KEYBOARD = {
  inline_keyboard: [
    [{ text: "⏱ ۱۰ دقیقه", callback_data: CB_SNOOZE_10 }, { text: "⏱ ۱ ساعت", callback_data: CB_SNOOZE_60 }],
    [{ text: "📅 فردا همین ساعت", callback_data: CB_SNOOZE_TOMORROW }, { text: "✅ انجام شد", callback_data: CB_DONE }],
  ],
};


/* ---------------- Calendar names ---------------- */

export const J_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];

export const G_MONTHS_FA = ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"];

export const DOW_FA = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];

export const DOW_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const WEEKDAY_KEYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const REPEAT_KINDS = new Set(["daily", "weekly", "monthly", "yearly"]);

export const J_MONTH_FORMS = [
  ["فروردین", 1], ["اردیبهشت", 2], ["خرداد", 3], ["تیر", 4], ["مرداد", 5], ["شهریور", 6],
  ["مهر", 7], ["آبان|ابان", 8], ["آذر|اذر", 9], ["دی", 10], ["بهمن", 11], ["اسفند", 12],
];

export const J_MONTH_ALT = J_MONTH_FORMS.map(([s]) => s).join("|");
