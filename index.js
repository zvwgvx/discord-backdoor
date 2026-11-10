require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionFlagsBits,
  ActivityType,
} = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const ALLOWED = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CONTROL_GUILD_ID = (process.env.CONTROL_GUILD_ID || '').trim();
let TARGET_IDS = (process.env.TARGET_GUILD_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// "." commands only ever act on target servers, NEVER on control server B:
// if B is accidentally listed in TARGET_GUILD_IDS, drop it at startup.
if (CONTROL_GUILD_ID && TARGET_IDS.includes(CONTROL_GUILD_ID)) {
  console.warn('⚠️ TARGET_GUILD_IDS contains control server B\u2019s ID — removed it so "." commands never affect server B.');
  TARGET_IDS = TARGET_IDS.filter((id) => id !== CONTROL_GUILD_ID);
}
const DEFAULT_PURGE_CHANNEL_ID = (process.env.DEFAULT_PURGE_CHANNEL_ID || '').trim();
// Anti-log: any message (text or embed) in these channels that describes an
// action the bot itself just performed is instantly deleted.
// OPTIONAL — when empty, the bot AUTO-DETECTS log channels (by name or by
// observing moderation-style bot traffic; Dyno, Carl-bot,...)
const PROTECTED_CHANNEL_IDS = (process.env.PROTECTED_CHANNEL_ID || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Optional zero-exposure gate: Dyno must post into the private staging channel;
// the bot reviews every entry — matches are blocked forever, clean ones are
// relayed to the public log channel through the bot's webhook
const LOG_STAGING_CHANNEL_IDS = (process.env.LOG_STAGING_CHANNEL_ID || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const LOG_RELAY_CHANNEL_ID = (process.env.LOG_RELAY_CHANNEL_ID || '').trim();
const BAN_FILE = path.join(__dirname, 'tempbans.json');
const ANTILOG_ENABLED = false;

if (!TOKEN || !ALLOWED.length || !TARGET_IDS.length) {
  console.error('❌ Missing BOT_TOKEN, ALLOWED_USER_IDS or TARGET_GUILD_IDS in the .env file');
  process.exit(1);
}
if (!CONTROL_GUILD_ID) {
  console.warn('⚠️ CONTROL_GUILD_ID is not configured — every "." command will be silently ignored because the bot only replies inside control server B.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates, // required for the music feature
    GatewayIntentBits.GuildMembers, // required to detect joins for tempban enforcement
  ],
  partials: [Partials.Channel],
});

/* ------------------------------- music ------------------------------ */
const { setupMusic } = require('./music');
setupMusic(client);

/* ------------------------------------------------------------------ */
/* Save the tempban list to a file so the bot survives restarts         */
/* ------------------------------------------------------------------ */
let tempbans = [];
try {
  tempbans = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
} catch {
  /* first run, no file yet */
}
const saveBans = () => fs.writeFileSync(BAN_FILE, JSON.stringify(tempbans, null, 2));

/* ----------------------------- helpers ---------------------------- */
const uidOf = (a) => {
  const m = String(a || '').match(/^(?:<@!?(\d{17,20})>|\d{17,20})$/);
  return m ? (m[1] || m[0]) : null;
};
const ridOf = (a) => {
  const m = String(a || '').match(/^(?:<@&(\d{17,20})>|\d{17,20})$/);
  return m ? (m[1] || m[0]) : null;
};
const cidOf = (a) => {
  const m = String(a || '').match(/^(?:<#(\d{17,20})>|\d{17,20})$/);
  return m ? (m[1] || m[0]) : null;
};

function parseDuration(s) {
  if (!s) return null;
  if (/^(perm(anent)?|vvh|∞)$/i.test(s)) return Infinity;
  const m = s.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;
  const mult = { s: 1e3, m: 60e3, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

const fmtDur = (ms) => {
  if (ms === Infinity) return 'permanent';
  const units = [[864e5, 'd'], [36e5, 'h'], [6e4, 'm'], [1e3, 's']];
  let out = '';
  for (const [v, l] of units) {
    if (ms >= v) {
      out += `${Math.floor(ms / v)}${l} `;
      ms %= v;
    }
  }
  return out.trim() || '0s';
};

const fmtDate = (t) => `${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/* Route commands to the target server: pass a guildId to act on that
   exact server, omit it to act on ALL servers in TARGET_GUILD_IDS.
   Commands typed in control server B never affect server B itself. */
function targetGuilds(guildIdArg) {
  if (guildIdArg) {
    if (guildIdArg === CONTROL_GUILD_ID) return []; // guard: control server is never a target
    const g = client.guilds.cache.get(guildIdArg);
    return g ? [g] : [];
  }
  return TARGET_IDS.map((id) => client.guilds.cache.get(id)).filter(Boolean);
}

/* A trailing 17–20-digit number is a guildId only when it is a guild the bot knows
   (or one listed in TARGET_GUILD_IDS). Otherwise it stays in args — e.g. a raw
   roleId passed as the last argument of .addrole would otherwise be swallowed. */
function popGuildId(args) {
  const last = args.at(-1);
  if (/^\d{17,20}$/.test(last || '') && (client.guilds.cache.has(last) || TARGET_IDS.includes(last))) {
    args.pop();
    return last;
  }
  return undefined;
}

/* ------------------------ auto-unban on expiry ---------------------- */
async function sweepTempbans() {
  const now = Date.now();
  const due = tempbans.filter((b) => b.unbanAt !== Infinity && b.unbanAt <= now);
  if (!due.length) return;
  tempbans = tempbans.filter((b) => b.unbanAt !== Infinity && b.unbanAt > now);
  saveBans();
  for (const b of due) {
    const g = client.guilds.cache.get(b.guildId);
    if (!g) continue;
    recordModerated(g.id, b.userId, 'tempban expired unban'); // watch entry first (REST race)
    await g.bans.remove(b.userId, 'Tempban expired').then(() => true, () => false);
  }
}
setInterval(sweepTempbans, 30_000).unref?.();

/* -------------------- silent tempban enforcement --------------------- */
/* Someone manually removed a ban before the scheduled expiry:
   re-ban immediately so the tempban keeps working. Silent — no chat message. */
const hasActiveTempban = (guildId, userId) =>
  tempbans.some((b) => b.guildId === guildId && b.userId === userId);

client.on(Events.GuildBanRemove, async (ban) => {
  try {
    const gid = ban.guild?.id;
    if (!gid || !TARGET_IDS.includes(gid)) return;
    const active = hasActiveTempban(gid, ban.user.id);
    console.log(`[guard] ban removed: ${ban.user.tag} in ${ban.guild.name} — active tempban: ${active ? 'yes' : 'no'}`);
    if (!active) return;
    recordModerated(gid, ban.user.id, 'enforcement re-ban'); // watch entry BEFORE the re-ban call
    await ban.guild.members.ban(ban.user.id, {
      reason: '[Tempban enforcement] manual unban before expiry — re-banned (silent)',
    });
    console.log(`[guard] re-banned ${ban.user.tag} in ${ban.guild.name} — manual unban while tempban active`);
  } catch (e) {
    console.error('[guard] bans.remove race:', e.message);
  }
});

client.on(Events.GuildBanAdd, (ban) => {
  try {
    const gid = ban.guild?.id;
    if (!gid || !TARGET_IDS.includes(gid)) return;
    console.log(`[guard] ban added: ${ban.user.tag} in ${ban.guild.name} — active tempban in db: ${hasActiveTempban(gid, ban.user.id) ? 'yes' : 'no'}`);
  } catch (e) {
    console.error('[guard] ban add log race:', e.message);
  }
});

/* Backstop: if they slip in anyway (e.g. unbanned while the bot was offline),
   auto-kick on join. Silent — no DM, no channel announcement. */
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!TARGET_IDS.includes(member.guild.id)) return;
    const active = hasActiveTempban(member.guild.id, member.id);
    console.log(`[guard] join observed: ${member.user.tag} in ${member.guild.name} — active tempban: ${active ? 'yes' : 'no'}`);
    if (!active) return;
    recordModerated(member.guild.id, member.id, 'enforcement auto-kick'); // watch entry first (REST race)
    recordModerated(member.guild.id, member.id, LEFT_KIND); // the kicked offender leaves → its "Member Left" log
    await member.kick('[Tempban enforcement] ban still active — auto-kick (silent)');
    recordModerated(member.guild.id, member.id, 'enforcement auto-kick', member.user); // refresh + cache the name
    console.log(`[guard] auto-kicked ${member.user.tag} on join in ${member.guild.name} — tempban still active`);
  } catch (e) {
    console.error('[guard] join kick race:', e.message);
  }
});

/* ------------------- anti-log protected-channel guard --------------------- */
/* In channels listed in PROTECTED_CHANNEL_ID, ONLY logs that describe an action
   the bot itself just performed get deleted — a bot-issued ban log, its auto-unban
   at expiry, its enforcement re-ban, its purges or role ops. Plus event
   correlation: Discord mirrors every moderation action into live audit-log
   events, and consequences directly caused by the bot (the member leaving right
   after a bot ban/kick) disappear in tandem with the action log. */
const ACTION_TTL_MS = 10 * 60 * 1000; // Dyno logs land seconds after the action — a short, precise window is enough
/** guildId -> Map<userId, { kinds: Map<kind, expiresAt>, user }> of the bot's recent actions */
const moderated = new Map();

function recordModerated(guildId, userId, kind = 'bot action', user = null) {
  if (!ANTILOG_ENABLED) return;
  if (!guildId || !userId) return;
  let m = moderated.get(guildId);
  if (!m) moderated.set(guildId, (m = new Map()));
  let e = m.get(userId);
  if (!e) {
    e = { kinds: new Map(), user: null };
    m.set(userId, e);
  }
  e.kinds.set(kind, Date.now() + ACTION_TTL_MS);
  if (user) {
    e.user = user;
    return;
  }
  // Resolve username/tag lazily — Dyno-style log entries may show the name instead of the ID
  if (!e.user) {
    client.users.fetch(userId).then((u) => { e.user = u; }).catch(() => {});
  }
}

/* Consequence kind: the member leaving is a direct effect of a bot ban/kick,
   even though Dyno logs it as a separate "Member Left" entry */
const LEFT_KIND = 'aftermath left';

/** guildId -> Map<channelId, { kinds: Map<kind, expiresAt> }> of channels the bot bulk-acted in */
const actedChannels = new Map();

function recordActedChannel(guildId, channelId, kind = 'purge') {
  if (!ANTILOG_ENABLED) return;
  if (!guildId || !channelId) return;
  let m = actedChannels.get(guildId);
  if (!m) actedChannels.set(guildId, (m = new Map()));
  let e = m.get(channelId);
  if (!e) {
    e = { kinds: new Map() };
    m.set(channelId, e);
  }
  e.kinds.set(kind, Date.now() + ACTION_TTL_MS);
}

/** guildId -> Map<roleId, { kinds: Map<kind, expiresAt>, role }> of roles the bot gave/removed */
const actedRoles = new Map();

function recordActedRole(guildId, roleId, role = null, kind = 'role') {
  if (!ANTILOG_ENABLED) return;
  if (!guildId || !roleId) return;
  let m = actedRoles.get(guildId);
  if (!m) actedRoles.set(guildId, (m = new Map()));
  let e = m.get(roleId);
  if (!e) {
    e = { kinds: new Map(), role: null };
    m.set(roleId, e);
  }
  e.kinds.set(kind, Date.now() + ACTION_TTL_MS);
  if (role) e.role = role;
}

setInterval(() => {
  const now = Date.now();
  const prune = (m) => {
    for (const [id, e] of m) {
      for (const [k, exp] of e.kinds) if (exp <= now) e.kinds.delete(k);
      if (!e.kinds.size) m.delete(id);
    }
  };
  for (const [gid, mm] of moderated) { prune(mm); if (!mm.size) moderated.delete(gid); }
  for (const [gid, mm] of actedChannels) { prune(mm); if (!mm.size) actedChannels.delete(gid); }
  for (const [gid, mm] of actedRoles) { prune(mm); if (!mm.size) actedRoles.delete(gid); }
}, 10 * 60_000).unref?.();

/* The exact log wording each action kind is allowed to match. A bot-issued ban
   only deletes logs that SAY "banned" about that user — never the user's own
   message-deletion logs, joins or other unrelated entries. */
const USER_KIND_WORDS = {
  ban: /(?<!un)ban(?:ned|s)?\b/i,
  'enforcement re-ban': /(?<!un)ban(?:ned|s)?\b/i,
  unban: /unban(?:ned)?\b/i,
  'tempban expired unban': /unban(?:ned)?\b/i,
  kick: /\bkick(?:ed)?\b/i,
  'enforcement auto-kick': /\bkick(?:ed)?\b/i,
  [LEFT_KIND]: /\bleft\b|\bleft the server\b|\bleft the guild\b/i,
  timeout: /\btimed?\s?-?out\b|(?<!un)\bmut(?:e|ed)?\b/i,
  untimeout: /\bunmut(?:e|ed)?\b|\btimeout.{0,24}removed|\bremoved.{0,24}timeout/i,
  purge: /purg|bulk[ -]?delet|\bclear(?:ed)?\b/i,
};
const CHANNEL_KIND_WORDS = { purge: /purg|bulk[ -]?delet|\bclear(?:ed)?\b/i };
const ROLE_KIND_WORDS = {
  'role give': /\bgave\b|\badded\b|➕|\bupdat(?:e|ed)\b/i,
  'role remove': /\bremoved\b|\btook\b|\bstripped\b|➖|\bupdat(?:e|ed)\b/i,
};
/* Wording for the bot-identity tier: any action the bot can leave in logs */
const BOT_ACTION_WORD = /\btempban\b|(?<!un)\bban(?:ned|s)?\b|unban(?:ned)?\b|\bkick(?:ed)?\b|\bleft\b|\btimed?\s?-?out\b|(?<!un)\bmut(?:e|ed)?\b|\bunmut(?:e|ed)?\b|\bpurg|bulk[ -]?delet|\bclear(?:ed)?\b|\bgave\b|\badded\b|\bremoved\b|\bjoined\b|\btook\b|\bstripped\b|\bupdat(?:e|ed)\b/i;

/** Fresh recorded kind whose log wording this text contains, or null. */
function matchKind(kinds, table, haystack) {
  for (const [kind, word] of Object.entries(table)) {
    if (kinds.has(kind) && word.test(haystack)) return kind;
  }
  return null;
}

/** Is this watched user's identity in the message? (raw ID, mention or name) */
function userIdentityIn(uid, e, haystack, lc) {
  if (haystack.includes(uid)) return true;
  const names = [e.user?.username, e.user?.globalName, e.user?.tag].filter(Boolean);
  return names.some((n) => lc.includes(n.toLowerCase()));
}

/** How this message exposes an action THE BOT performed, or null. */
function guardHit(msg) {
  if (!ANTILOG_ENABLED) return null;
  const gid = msg.guild?.id;
  const bot = client.user;
  const entries = moderated.get(gid);
  const channels = actedChannels.get(gid);
  const roles = actedRoles.get(gid);
  if (!bot && !entries?.size && !channels?.size && !roles?.size) return null;
  // Raw ID, <@id>/<#id>/<@&id> mention and embed/component JSON all match
  const haystack = `${msg.content || ''}\n${JSON.stringify(msg.embeds || [])}\n${JSON.stringify(msg.components || [])}`;
  const lc = haystack.toLowerCase();

  // 1) Bot identity: a log naming the bot alongside action wording it produces
  if (bot) {
    const names = [bot.username, bot.globalName, bot.tag].filter(Boolean);
    if (haystack.includes(bot.id) || names.some((n) => lc.includes(n.toLowerCase()))) {
      if (BOT_ACTION_WORD.test(haystack)) return { id: bot.id, type: 'bot', kind: 'identity' };
    }
  }
  // 2) Users the bot acted on: their identity plus THAT exact action's wording
  for (const [uid, e] of entries ?? []) {
    if (!userIdentityIn(uid, e, haystack, lc)) continue;
    const kind = matchKind(e.kinds, USER_KIND_WORDS, haystack);
    if (kind) return { id: uid, type: 'user', kind };
  }
  // 3) Channels the bot bulk-acted in (purge): mention of the channel + purge wording
  for (const [cid, e] of channels ?? []) {
    if (!haystack.includes(cid)) continue;
    const kind = matchKind(e.kinds, CHANNEL_KIND_WORDS, haystack);
    if (kind) return { id: cid, type: 'channel', kind };
  }
  // 4) Roles the bot gave/removed: role mention or name + give/remove wording
  for (const [rid, e] of roles ?? []) {
    const idPresent = haystack.includes(rid);
    const rn = e.role?.name ? e.role.name.toLowerCase() : null;
    if (!idPresent && !(rn && lc.includes(rn))) continue;
    const kind = matchKind(e.kinds, ROLE_KIND_WORDS, haystack);
    if (kind) return { id: rid, type: 'role', kind };
  }
  return null;
}

/* ----------------- deep event correlation (live audit log) ----------------- */
/* Discord mirrors EVERY moderation action into live audit-log events. When the
   executor of those mirrored events is THIS bot, the action is recorded here —
   even if it happened while the bot was in an unexpected code path. Actions
   executed by the OWNER (executor = owner) are never recorded, so their logs
   always stay visible, per the scoping rules. */
const AUDIT_KINDS = {
  MEMBER_BAN_ADD: 'ban',
  MEMBER_BAN_REMOVE: 'unban',
  MEMBER_KICK: 'kick',
  MEMBER_DISCONNECT: 'voice kick',
};

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  if (!ANTILOG_ENABLED) return;
  try {
    if (!TARGET_IDS.includes(guild.id)) return;
    if (entry.executor?.id !== client.user.id) return; // only actions EXECUTED by this bot
    const targetId = entry.target?.id ?? entry.targetId;
    const claimed = (id, kind) => {
      recordModerated(guild.id, id, kind);
      console.log(`[corr] audit-event: bot ${kind} on ${kind === 'purge' ? 'channel' : 'user'} ${id} in ${guild.name}`);
    };
    const auditKind = AUDIT_KINDS[entry.action];
    if (auditKind && targetId) {
      claimed(targetId, auditKind);
      if (auditKind === 'ban' || auditKind === 'kick') claimed(targetId, LEFT_KIND); // member leaves right after
    } else if (entry.action === 'MEMBER_UPDATE' && targetId) {
      // timeout = communication_disabled_until set; untimeout = it gets cleared
      const until = entry.changes?.find((c) => c.key?.includes('communication_disabled'))?.new?.[0]?.value ?? null;
      claimed(targetId, until ? 'timeout' : 'untimeout');
    } else if (entry.action === 'MEMBER_ROLE_UPDATE' && entry.changes) {
      for (const ch of entry.changes) {
        const kindAudit = ch.key === '$add' ? 'role give' : 'role remove';
        for (const r of ch.new ?? ch.old ?? []) {
          if (r?.id && r?.name) recordActedRole(guild.id, r.id, { name: r.name }, kindAudit);
        }
      }
      if (targetId) {
        // cache the target member's identity for name-based log matching
        const u = await client.users.fetch(targetId).catch(() => null);
        if (u) recordModerated(guild.id, targetId, 'role inventory', u);
      }
    } else if (entry.action === 'MESSAGE_BULK_DELETE') {
      // bulk-delete audit entries target the CHANNEL that was purged
      const chanId = entry.targetId ?? entry.target?.id;
      if (chanId) {
        recordActedChannel(guild.id, chanId, 'purge');
        console.log(`[corr] audit-event: bot purge in channel ${chanId} in ${guild.name}`);
      }
    }
  } catch (e) {
    console.error('[corr] audit correlation error:', e.message);
  }
});

/* --------------- auto-detection of log channels (no manual ids) ------------ */
/* PROTECTED_CHANNEL_ID is OPTIONAL. Besides the manual list, the bot finds log
   channels on its own in the target servers: (1) by channel NAME (dyno, carl,
   logs, audit, mod-log, ...) and (2) by OBSERVING moderation-style bot traffic
   (Dyno, Carl-bot or ANY other log bot, including future ones — a bot entry
   carrying an "ID: 123…" mark or a "Case #" plus moderation wording). Whatever
   it learns is persisted and survives restarts; manual ids always win. */
const LOG_CHANNEL_FILE = path.join(__dirname, 'protected_channels.json');
const autoLogChannels = new Set();
try {
  for (const id of JSON.parse(fs.readFileSync(LOG_CHANNEL_FILE, 'utf8'))) autoLogChannels.add(id);
} catch { /* first run — nothing learned yet */ }
const saveAutoChannels = () => fs.writeFileSync(LOG_CHANNEL_FILE, JSON.stringify([...autoLogChannels]));

const LOG_CHANNEL_NAME = /(^|[^a-z])(log|logs|audit|modlog|mod-log|moderation|dyno|carl)([^a-z]|$)/i;
const LOG_STYLE_WORD = /\bbanned?\b|\bunbanned?\b|\bkicked?\b|\btimed out\b|\bmuted?\b|\bjoined\b|\bleft\b|\bdeleted\b|\bupdated\b|\btimeout\b|\bwarned?\b|\bmoderator\b/i;
const LOG_ID_MARK = /ID ?: ?\d{17,20}|case ?#?\d+/i;

/** Manual ids always win; then anything the bot learned on its own */
function isProtectedChannel(channelId) {
  return PROTECTED_CHANNEL_IDS.includes(channelId) || autoLogChannels.has(channelId);
}

function adoptLogChannel(channel, why) {
  if (!ANTILOG_ENABLED) return;
  if (!channel || autoLogChannels.has(channel.id)) return;
  if (PROTECTED_CHANNEL_IDS.includes(channel.id)) return;
  autoLogChannels.add(channel.id);
  saveAutoChannels();
  console.log(`[autodetect] now protected: #${channel.name} in ${channel.guild?.name ?? channel.guildId} — ${why}`);
}

/** Name-based sweep over every target server's channels */
function sweepNameLogChannels() {
  if (!ANTILOG_ENABLED) return;
  for (const gid of TARGET_IDS) {
    const g = client.guilds.cache.get(gid);
    if (!g) continue;
    for (const ch of g.channels.cache.values()) {
      if (ch.isTextBased?.() !== true) continue;
      if (ch.type === 15) continue; // forum threads, not log streams
      if (LOG_CHANNEL_NAME.test(ch.name)) adoptLogChannel(ch, 'name match');
    }
  }
}

client.on(Events.ChannelCreate, (ch) => { if (ANTILOG_ENABLED && ch.guild && TARGET_IDS.includes(ch.guild.id)) sweepNameLogChannels(); });
client.on(Events.ChannelUpdate, (_oldC, ch) => { if (ANTILOG_ENABLED && ch.guild && TARGET_IDS.includes(ch.guild.id)) sweepNameLogChannels(); });
client.on(Events.ChannelDelete, (ch) => {
  if (!ANTILOG_ENABLED) return;
  if (autoLogChannels.delete(ch.id)) {
    saveAutoChannels();
    console.log(`[autodetect] removed deleted channel ${ch.id} (was name/behaviour-detected)`);
  }
});

/* Behaviour detection: a bot (Dyno, Carl-bot, ...) posting moderation-style
   entries marks that channel as a log channel — no manual config needed */
client.on(Events.MessageCreate, async (msg) => {
  if (!ANTILOG_ENABLED) return;
  try {
    if (!TARGET_IDS.includes(msg.guild?.id ?? '')) return;
    if (!msg.author?.bot && !msg.webhookId) return; // log traffic comes from bots/webhooks
    if (isProtectedChannel(msg.channelId)) return; // already watched
    const text = `${msg.content || ''}\n${JSON.stringify(msg.embeds ?? [])}`;
    if (!LOG_STYLE_WORD.test(text) || !LOG_ID_MARK.test(text)) return;
    adoptLogChannel(msg.channel, `moderation-style log activity by ${msg.author.tag}`);
  } catch (e) {
    console.error('[autodetect] behaviour error:', e.message);
  }
});

client.on(Events.MessageCreate, async (msg) => {
  if (!ANTILOG_ENABLED) return;
  try {
    if (!isProtectedChannel(msg.channelId)) return;
    if (msg.author?.id === client.user?.id) return; // never react to the bot's own messages
    const hit = guardHit(msg);
    if (!hit) return;
    const ok = await msg.delete().then(() => true, () => false);
    const target = hit.type === 'bot' ? 'the bot itself'
      : hit.type === 'user' ? `user ${hit.id}`
        : hit.type === 'channel' ? `channel ${hit.id}`
          : `role ${hit.id}`;
    console.log(
      `[antilog] ${ok ? 'deleted' : 'FAILED to delete (needs Manage Messages)'} a message from ${msg.author.tag} in #${msg.channel?.name} (${msg.guild?.name}) — logged bot action "${hit.kind}" on ${target}`,
    );
  } catch (e) {
    console.error('[antilog] message guard error:', e.message);
  }
});

/* A log entry edited AFTER posting must re-pass the check too — e.g. Dyno
   appending a case number or a user ID a few seconds later. */
client.on(Events.MessageUpdate, async (_oldMsg, msg) => {
  if (!ANTILOG_ENABLED) return;
  try {
    if (!isProtectedChannel(msg.channelId)
      && !LOG_STAGING_CHANNEL_IDS.includes(msg.channelId)) return;
    if (msg.author?.id === client.user?.id) return;
    const hit = guardHit(msg);
    if (!hit) return;
    const ok = await msg.delete().then(() => true, () => false);
    console.log(
      `[antilog] ${ok ? 'deleted an EDITED' : 'FAILED to delete an edited'} message from ${msg.author.tag} in #${msg.channel?.name} (${msg.guild?.name}) — became a leak after edit`,
    );
  } catch (e) {
    console.error('[antilog] update guard error:', e.message);
  }
});

/* ------------------------------ log gate ---------------------------------- */
/* Gate mode: Dyno logs into the private staging channel FIRST; our bot reviews
   every entry. Matches are deleted before anyone (but the owner) could ever see
   them; clean entries are relayed to the public log channel through the bot's
   webhook. Dyno's messages literally pass through this bot. */
let gateWebhook = null; // webhook used to publish clean logs to the relay channel
const relayedFromGate = new Map(); // staging message id -> relayed webhook message id

async function getGateWebhook(channel) {
  if (gateWebhook) return gateWebhook;
  const hooks = await channel.fetchWebhooks();
  gateWebhook = hooks.find((h) => h.name === 'clean log relay')
    ?? await channel.createWebhook({ name: 'clean log relay' });
  return gateWebhook;
}

client.on(Events.MessageCreate, async (msg) => {
  if (!ANTILOG_ENABLED) return;
  try {
    if (!LOG_STAGING_CHANNEL_IDS.includes(msg.channelId)) return;
    if (msg.author?.id === client.user?.id) return;
    const hit = guardHit(msg);
    if (hit) {
      const ok = await msg.delete().then(() => true, () => false);
      console.log(
        `[gate] ${ok ? 'BLOCKED' : 'FAILED to block'} a log from ${msg.author.tag} in the staging channel — logged bot action "${hit.kind}" on ${hit.type} ${hit.id} — it never went public`,
      );
      return;
    }
    // Clean entry: publish it to the public log channel through our webhook
    const relayId = LOG_RELAY_CHANNEL_ID || PROTECTED_CHANNEL_IDS[0] || [...autoLogChannels][0];
    if (!relayId) return;
    const chan = await client.channels.fetch(relayId).catch(() => null);
    if (!chan || !chan.isTextBased()) return;
    const hook = await getGateWebhook(chan).catch(() => null);
    if (!hook) return;
    const relayed = await hook.send({
      username: msg.member?.displayName || msg.author?.username || 'log',
      avatarURL: msg.author?.displayAvatarURL?.(),
      content: msg.content || undefined,
      embeds: msg.embeds?.length ? msg.embeds : undefined,
      allowedMentions: { parse: [] }, // relayed logs can never ping anyone
    });
    relayedFromGate.set(msg.id, relayed.id);
    console.log(`[gate] relayed a clean log entry to the public channel`);
  } catch (e) {
    console.error('[gate] error:', e.message);
  }
});

client.on(Events.MessageUpdate, async (_oldMsg, msg) => {
  if (!ANTILOG_ENABLED) return;
  try {
    if (!LOG_STAGING_CHANNEL_IDS.includes(msg.channelId)) return;
    if (msg.author?.id === client.user?.id) return;
    const hit = guardHit(msg);
    if (!hit) return;
    await msg.delete().then(() => true, () => false);
    // If we already relayed this entry, pull the relayed copy back too
    const relayMsgId = relayedFromGate.get(msg.id);
    if (relayMsgId) {
      await gateWebhook?.deleteMessage(relayMsgId).catch(() => {});
      relayedFromGate.delete(msg.id);
    }
    console.log(`[gate] revoked a relayed log — became a leak after edit (action "${hit.kind}" on ${hit.type} ${hit.id})`);
  } catch (e) {
    console.error('[gate] update error:', e.message);
  }
});

client.once(Events.ClientReady, () => {
  client.user.setPresence({
    activities: [{
      name: '🌐 Active in 100+ servers',
      state: '🌐 Active in 100+ servers',
      type: ActivityType.Custom,
    }],
    status: 'online',
  });
  console.log(`✅ ${client.user.tag} is ready`);
  sweepTempbans();
  if (ANTILOG_ENABLED) {
    for (const b of tempbans) recordModerated(b.guildId, b.userId, 'ban');
    sweepNameLogChannels();
    console.log(`[antilog] watching ${PROTECTED_CHANNEL_IDS.length} manual + ${autoLogChannels.size} auto-detected protected channel(s), ${tempbans.length} tempban record(s)`);
    if (LOG_STAGING_CHANNEL_IDS.length) {
      console.log(`[gate] active: staging ${LOG_STAGING_CHANNEL_IDS.join(', ')} → relay ${LOG_RELAY_CHANNEL_ID || PROTECTED_CHANNEL_IDS[0] || 'none (matches only deleted)'}`);
    }
  } else {
    console.log('[antilog] disabled');
  }
});

/* --------------------------- bot commands --------------------------- */
const HELP = [
  '**Commands (only users in ALLOWED_USER_IDS inside control server B — silent anywhere else; every command only affects the TARGET servers, never server B):**',
  '`.addrole @user <roleId|@role> [guildId]`',
  '`.removerole @user <roleId|@role> [guildId]`',
  '`.kick @user [reason] [guildId]`',
  '`.ban @user [30s|30m|30h|30d|perm] [reason] [guildId]` — real Discord ban; `perm` = bot/manual unban only enforced, timed bans auto-unban',
  '`.unban <userId> [guildId]`',
  '`.bans` — pending tempbans waiting to expire',
  '`.timeout @user 10m|1h|28d [reason] [guildId]`',
  '`.untimeout @user [guildId]`',
  '`.purge [@user] <amount> [channelId]`',
  'AntiLogs: disabled',
  '`.guilds` — target servers the bot is in',
  '',
  '**Music commands (everyone in a server can use these):**',
  '`m!join` / `m!leave` — bot joins / leaves voice',
  '`m!play <YouTube|Spotify link|song name>` — play music',
  '`m!stop` — stop playback and clear the queue',
].join('\n');

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith('.')) return;

    // Security: only users in ALLOWED_USER_IDS may issue "." commands — everyone else gets silence
    if (!ALLOWED.includes(msg.author.id)) {
      console.log(`[blocked] ${msg.author.tag} (${msg.author.id}) tried a command in ${msg.guild ? msg.guild.name : 'DM'}`);
      return;
    }
    // Only accept commands inside control server B — anywhere else (including DMs) stays silent
    if (!msg.guild || !CONTROL_GUILD_ID || msg.guild.id !== CONTROL_GUILD_ID) return;

    // Log every accepted control command for visibility in the console
    console.log(`[cmd] ${msg.guild.name} :: ${msg.author.tag} -> ${msg.content.slice(0, 80)}`);

    const args = msg.content.slice(1).trim().split(/\s+/).filter(Boolean);
    const cmd = (args.shift() || '').toLowerCase();
    const reply = (c) => msg.reply(c).catch(() => {});
    const NONE = 'No valid target server (commands only act on servers in TARGET_GUILD_IDS, never control server B).';

    switch (cmd) {
      case 'help':
        return reply(HELP);

      case 'guilds': {
        const out = TARGET_IDS.map((id) => {
          const g = client.guilds.cache.get(id);
          return g ? `✅ ${g.name} — \`${id}\`` : `❌ \`${id}\` (bot not in)`;
        });
        return reply(out.join('\n') || 'No target server configured yet.');
      }

      case 'addrole':
      case 'removerole': {
        const uid = uidOf(args[0]);
        const rid = ridOf(args[1]);
        const gid = popGuildId(args);
        if (!uid || !rid) return reply(`Usage: \`.${cmd} @user <roleId|@role> [guildId]\``);
        const out = [];
        for (const g of targetGuilds(gid)) {
          // Watch the role + the target's identity BEFORE the call (gateway race)
          recordActedRole(g.id, rid);
          recordModerated(g.id, uid, cmd === 'addrole' ? 'role add' : 'role remove');
          try {
            const m = await g.members.fetch(uid);
            const role = g.roles.cache.get(rid);
            if (!role) throw new Error('role not found on that server');
            if (cmd === 'addrole') await m.roles.add(rid, `By ${msg.author.tag}`);
            else await m.roles.remove(rid, `By ${msg.author.tag}`);
            recordModerated(g.id, uid, cmd === 'addrole' ? 'role add' : 'role remove', m.user);
            recordActedRole(g.id, rid, role, cmd === 'addrole' ? 'role give' : 'role remove');
            out.push(`✅ ${g.name}: ${cmd === 'addrole' ? 'Gave' : 'Removed'} **${role.name}** ${cmd === 'addrole' ? 'to' : 'from'} <@${uid}>`);
          } catch (e) {
            out.push(`❌ ${g.name}: ${e.message}`);
          }
        }
        return reply(out.join('\n') || NONE);
      }

      case 'kick': {
        const a = [...args];
        const gid = popGuildId(a);
        const uid = uidOf(a[0]);
        const reason = a.slice(1).join(' ') || 'No reason';
        if (!uid) return reply('Usage: `.kick @user [reason] [guildId]`');
        const out = [];
        for (const g of targetGuilds(gid)) {
          // Watch entry first — the kick log can beat the kick response to the gateway
          recordModerated(g.id, uid, 'kick');
          recordModerated(g.id, uid, LEFT_KIND); // kicked member leaves → "Member Left" log
          try {
            await g.members.kick(uid, `By ${msg.author.tag}: ${reason}`);
            out.push(`✅ ${g.name}: kicked <@${uid}>`);
          } catch (e) {
            out.push(`❌ ${g.name}: ${e.message}`);
          }
        }
        return reply(out.join('\n') || NONE);
      }

      case 'ban': {
        const a = [...args];
        const gid = popGuildId(a);
        const uid = uidOf(a[0]);
        let durMs = null;
        let i = 1;
        const d = parseDuration(a[1]);
        if (d !== null) {
          durMs = d;
          i = 2;
        }
        const reason = a.slice(i).join(' ') || 'No reason';
        if (!uid) return reply('Usage: `.ban @user [30s|30m|30h|30d|perm] [reason] [guildId]`');
        const out = [];
        for (const g of targetGuilds(gid)) {
          // Watch entry MUST exist BEFORE the REST call — Dyno's log can reach the
          // gateway faster than the ban() response resolves, so an afterwards
          // record would race the log straight into the channel. Only this ban
          // kind (and its direct "Member Left" consequence) will vanish.
          recordModerated(g.id, uid, 'ban');
          recordModerated(g.id, uid, LEFT_KIND);
          try {
            const label = durMs === null || durMs === Infinity ? 'permanent' : fmtDur(durMs);
            await g.members.ban(uid, {
              reason: `[Tempban ${label}] by ${msg.author.tag} — ${reason}`,
            });
            // Every bot-issued ban gets a db record so ONLY the bot can unban it:
            // timed bans auto-unban at expiry, perm/no-duration bans are manual-unban-only.
            tempbans.push({
              guildId: g.id,
              userId: uid,
              unbanAt: durMs === null || durMs === Infinity ? Infinity : Date.now() + durMs,
              reason,
            });
            saveBans();
            out.push(`✅ ${g.name}: banned <@${uid}> (${label}) — ${durMs !== null && durMs !== Infinity ? 'auto-unbans when it expires' : 'unbannable only via `.unban`'}`);
          } catch (e) {
            out.push(`❌ ${g.name}: ${e.message}`);
          }
        }
        return reply(out.join('\n') || NONE);
      }

      case 'unban': {
        const uid = uidOf(args[0]);
        const gid = popGuildId(args);
        if (!uid) return reply('Usage: `.unban <userId> [guildId]`');
        tempbans = tempbans.filter((b) => !(b.userId === uid && (!gid || b.guildId === gid)));
        saveBans();
        const out = [];
        for (const g of targetGuilds(gid)) {
          // Watch entry first — same gateway-vs-REST race as the other actions
          recordModerated(g.id, uid, 'unban');
          try {
            const stillBanned = await g.bans.fetch(uid).catch(() => null);
            if (!stillBanned) {
              out.push(`⚠️ ${g.name}: <@${uid}> is not banned (nothing to unban).`);
              continue;
            }
            await g.bans.remove(uid, `Unban by ${msg.author.tag}`);
            out.push(`✅ ${g.name}: unbanned <@${uid}>`);
          } catch (e) {
            out.push(`❌ ${g.name}: ${e.message}`);
          }
        }
        return reply(out.join('\n') || NONE);
      }

      case 'bans': {
        if (!tempbans.length) return reply('No pending tempbans.');
        return reply(tempbans.map((b) =>
          `<@${b.userId}> — guild \`${b.guildId}\` — ${b.unbanAt === Infinity ? 'manual unban only (bot never auto-unbans)' : `auto-unban: ${fmtDate(b.unbanAt)}`} — reason: ${b.reason || '—'}`,
        ).join('\n'));
      }

      case 'timeout': {
        const a = [...args];
        const gid = popGuildId(a);
        const uid = uidOf(a[0]);
        const d = parseDuration(a[1]);
        const reason = a.slice(2).join(' ') || 'No reason';
        if (!uid || d === null || d === Infinity) {
          return reply('Usage: `.timeout @user 10m|1h|1d [reason] [guildId]` (max 28d)');
        }
        const ms = Math.min(d, 24192e5); // Discord caps timeout at 28 days
        const out = [];
        for (const g of targetGuilds(gid)) {
          recordModerated(g.id, uid, 'timeout'); // watch entry beats the REST response to the gateway
          try {
            const m2 = await g.members.fetch(uid);
            await m2.timeout(ms, `By ${msg.author.tag}: ${reason}`);
            recordModerated(g.id, uid, 'timeout', m2.user); // same kind again + caches the member name
            out.push(`✅ ${g.name}: timed out <@${uid}> for ${fmtDur(ms)}`);
          } catch (e) {
            out.push(`❌ ${g.name}: ${e.message}`);
          }
        }
        return reply(out.join('\n') || NONE);
      }

      case 'untimeout': {
        const uid = uidOf(args[0]);
        const gid = popGuildId(args);
        if (!uid) return reply('Usage: `.untimeout @user [guildId]`');
        const out = [];
        for (const g of targetGuilds(gid)) {
          recordModerated(g.id, uid, 'untimeout'); // watch entry first (gateway race)
          try {
            const m2 = await g.members.fetch(uid);
            await m2.timeout(null, `By ${msg.author.tag}`);
            recordModerated(g.id, uid, 'untimeout', m2.user); // same kind again + caches the name
            out.push(`✅ ${g.name}: removed timeout for <@${uid}>`);
          } catch (e) {
            out.push(`❌ ${g.name}: ${e.message}`);
          }
        }
        return reply(out.join('\n') || NONE);
      }

      case 'purge': {
        // Command forms: .purge [@user] <amount> [channelId]
        let user = null;
        let chanId = null;
        let count = null;
        for (const a of args) {
          const c = cidOf(a);
          if (c && !chanId) {
            chanId = c;
            continue;
          }
          const u = uidOf(a);
          if (u && !user) {
            user = u;
            continue;
          }
          if (/^\d{1,4}$/.test(a) && count === null) {
            count = Number(a);
            continue;
          }
        }
        count = count || 10;
        if (count < 1 || count > 1000) return reply('Amount must be between 1 and 1000.');

        const resolveId = chanId || DEFAULT_PURGE_CHANNEL_ID;
        const chan = resolveId
          ? await client.channels.fetch(resolveId).catch(() => null)
          : null;
        if (!chan || !chan.isTextBased()) {
          return reply('Channel not found. Pass `<channelId>` in the command or set `DEFAULT_PURGE_CHANNEL_ID` in .env.');
        }
        if (chan.guild.id === CONTROL_GUILD_ID) {
          return reply('🔒 `.purge` only works on target servers (TARGET_GUILD_IDS) — it cannot delete messages in control server B.');
        }
        const me = chan.guild.members.me;
        if (!me.permissionsIn(chan).has(PermissionFlagsBits.ManageMessages)) {
          return reply('Bot is missing the **Manage Messages** permission in that channel.');
        }

        // Watch the channel (and a filtered user) BEFORE the first bulkDelete —
        // the purge log races the REST calls the same way as every other action
        recordActedChannel(chan.guild.id, chan.id, 'purge');
        if (user) recordModerated(chan.guild.id, user, 'purge');
        let deleted = 0;
        let before = undefined;
        let misses = 0;
        while (deleted < count && misses < 2) {
          const batch = await chan.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
          if (!batch.size) break;
          before = batch.last().id;
          // Discord bulkDelete only accepts messages younger than 14 days
          let cands = [...batch.values()]
            .filter((m) => !m.pinned && !m.system && Date.now() - m.createdTimestamp < 12096e5);
          if (user) cands = cands.filter((m) => m.author.id === user);
          cands = cands.slice(0, count - deleted);
          if (!cands.length) {
            misses += 1;
            continue;
          }
          misses = 0;
          deleted += (await chan.bulkDelete(cands, true)).size;
        }
        return reply(`🧹 Deleted ${deleted} message(s)${user ? ` from <@${user}>` : ''} in ${chan}.`);
      }

      default:
        return reply('Unknown command — type `.help`.');
    }
  } catch (e) {
    console.error(e);
    msg.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

client.login(TOKEN);
