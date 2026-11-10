const { Events, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { DisTube } = require('distube');
const { YouTubePlugin } = require('@distube/youtube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin } = require('@distube/yt-dlp');

let ffmpegPath = process.env.FFMPEG_PATH || undefined;
if (!ffmpegPath) {
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch {
    ffmpegPath = undefined;
  }
}

const PREFIX = 'm!';
const COLOR = { normal: 0x5865f2, play: 0x57f287, warning: 0xfee75c, error: 0xed4245 };

function parseMusicCommand(content) {
  if (typeof content !== 'string') return null;
  const match = /^m!([a-z]+)(?:\s+([\s\S]*))?$/i.exec(content.trim());
  return match ? { name: match[1].toLowerCase(), argument: (match[2] || '').trim() } : null;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return 'LIVE';
  const n = Math.floor(value);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = String(n % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}

function text(value, limit = 100) {
  return escapeMarkdown(String(value || 'Unknown').replace(/\s+/g, ' ')).slice(0, limit);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function songLabel(song, limit = 95) {
  const title = text(song && song.name, limit);
  const url = safeUrl(song && song.url);
  return url ? '[' + title + '](' + url + ')' : title;
}

function card(title, description, color = COLOR.normal) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: 'Jokey Music' })
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'm!help  •  Music commands' });
}

function nowEmbed(queue) {
  const song = queue && queue.songs && queue.songs[0];
  if (!song) return card('Nothing playing', 'Use `m!play <song name or link>` to add a song.', COLOR.warning);
  const position = formatDuration(queue.currentTime || 0);
  const length = song.isLive ? 'LIVE' : formatDuration(song.duration);
  const result = card(queue.paused ? 'Paused' : 'Now playing',
    songLabel(song, 175) + '\n' +
    '**Time:** ' + position + ' / ' + length + '\n' +
    '**Volume:** ' + queue.volume + '%  ·  **Repeat:** ' + ['Off', 'Song', 'Queue'][queue.repeatMode] +
    '\n**Requested by:** ' + (song.member && song.member.id ? '<@' + song.member.id + '>' : 'Unknown'),
    queue.paused ? COLOR.warning : COLOR.play);
  const thumbnail = safeUrl(song.thumbnail);
  if (thumbnail) result.setThumbnail(thumbnail);
  return result;
}

function queueEmbed(queue) {
  if (!queue || !queue.songs || !queue.songs.length) {
    return card('Queue is empty', 'Queue a song with `m!play <name or URL>`.', COLOR.warning);
  }
  const lines = queue.songs.slice(1, 11).map((song, i) =>
    '**' + (i + 1) + '.** ' + songLabel(song, 85) + ' · ' + formatDuration(song.duration));
  return card('Music queue',
    '**Now playing**\n' + songLabel(queue.songs[0], 130) +
    '\n\n**Up next**\n' + (lines.length ? lines.join('\n') : 'No songs waiting.') +
    (queue.songs.length > 11 ? '\n\nAnd **' + (queue.songs.length - 11) + '** more.' : '') +
    '\n\n**Total:** ' + queue.songs.length + ' songs · **Repeat:** ' +
    ['Off', 'Song', 'Queue'][queue.repeatMode]);
}

function helpEmbed() {
  return card('Music commands',
    '**Playback**\n' +
    '`m!play <name or URL>` · `m!skip` · `m!stop`\n' +
    '`m!pause` · `m!resume` · `m!now`\n\n' +
    '**Queue**\n' +
    '`m!queue` · `m!shuffle` · `m!repeat <off|song|queue>`\n\n' +
    '**Voice & volume**\n' +
    '`m!join` · `m!leave` · `m!volume <0-150>`\n\n' +
    'Supports song searches, YouTube and Spotify URLs.');
}

function voiceIssue(member, guild, connected) {
  const userChannel = member && member.voice && member.voice.channel;
  if (!userChannel) return 'Join a voice channel first.';
  const botChannelId = guild && guild.members && guild.members.me && guild.members.me.voice.channelId;
  if (connected && !botChannelId) return 'The bot is not connected to a voice channel.';
  if (botChannelId && userChannel.id !== botChannelId) {
    return 'You must join the same voice channel as the bot.';
  }
  return null;
}

function respond(message, embed) {
  return message.reply({
    embeds: [embed],
    allowedMentions: { parse: [], repliedUser: false }
  }).catch((error) => console.error('[music] could not reply:', error.message));
}

function broadcast(channel, embed) {
  if (channel && channel.isSendable && channel.isSendable()) {
    return channel.send({ embeds: [embed], allowedMentions: { parse: [] } })
      .catch((error) => console.error('[music] could not send:', error.message));
  }
  return Promise.resolve();
}

function errorMessage(error) {
  const code = error && error.errorCode;
  if (['NO_RESULT', 'NO_SONG', 'NO_PLAYLIST'].includes(code)) {
    return 'No results found. Try another title or direct link.';
  }
  if (['VOICE_MISSING_PERMS', 'VOICE_CONNECT_FAILED', 'MISSING_PERMISSIONS'].includes(code)) {
    return 'The bot cannot join or speak in that voice channel. Check its permissions.';
  }
  return 'Could not complete the request. Try another track or check the voice connection.';
}

function createMusicHandler(distube) {
  return async function handleMusic(message) {
    if (!message || !message.guild || !message.author || message.author.bot) return;
    const parsed = parseMusicCommand(message.content);
    if (!parsed) return;

    const { name, argument } = parsed;
    const current = () => distube.getQueue(message.guildId);
    const warn = (title, detail) => respond(message, card(title, detail, COLOR.warning));
    const success = (title, detail) => respond(message, card(title, detail, COLOR.play));
    const failure = (detail) => respond(message, card('Music error', detail, COLOR.error));
    const guard = (connected = true) => {
      const issue = voiceIssue(message.member, message.guild, connected);
      if (issue) {
        failure(issue);
        return false;
      }
      return true;
    };

    try {
      if (name === 'help') return respond(message, helpEmbed());

      if (name === 'play' || name === 'p') {
        if (!argument) return warn('Usage', 'Type `m!play <song name or URL>`.');
        if (!guard(false)) return;
        await distube.play(message.member.voice.channel, argument, {
          member: message.member,
          textChannel: message.channel
        });
        return;
      }

      if (name === 'join') {
        if (!guard(false)) return;
        await distube.voices.join(message.member.voice.channel);
        return success('Connected', 'Joined **' + text(message.member.voice.channel.name) + '**.');
      }

      if (name === 'queue' || name === 'q') return respond(message, queueEmbed(current()));
      if (name === 'now' || name === 'np') return respond(message, nowEmbed(current()));

      if (name === 'leave' || name === 'disconnect') {
        if (!guard()) return;
        const queue = current();
        if (queue) await queue.stop();
        distube.voices.leave(message.guildId);
        return success('Disconnected', 'Left the voice channel and cleared the queue.');
      }

      if (!['stop', 'skip', 'pause', 'resume', 'volume', 'vol', 'repeat', 'loop', 'shuffle'].includes(name)) {
        return warn('Unknown command', 'Use `m!help` to see all music commands.');
      }

      if (!guard()) return;
      const queue = current();
      if (!queue) return warn('Nothing playing', 'Add a track with `m!play`.');

      if (name === 'stop') {
        await queue.stop();
        return success('Stopped', 'Playback stopped and the queue was cleared.');
      }

      if (name === 'skip') {
        const song = queue.songs[0];
        if (queue.songs.length < 2) {
          await queue.stop();
          return success('Skipped', 'Skipped ' + songLabel(song) + '. The queue is now empty.');
        }
        const next = await queue.skip();
        return success('Skipped', 'Now playing ' + songLabel(next) + '.');
      }

      if (name === 'pause') {
        if (queue.paused) return warn('Already paused', 'Use `m!resume` to continue.');
        await queue.pause();
        return success('Paused', 'Playback paused.');
      }

      if (name === 'resume') {
        if (!queue.paused) return warn('Already playing', 'Music is not paused.');
        await queue.resume();
        return success('Resumed', 'Playback resumed.');
      }

      if (name === 'shuffle') {
        if (queue.songs.length < 3) return warn('Not enough songs', 'Queue at least two upcoming songs to shuffle.');
        await queue.shuffle();
        return success('Shuffled', 'Upcoming songs were shuffled.');
      }

      if (name === 'repeat' || name === 'loop') {
        const modes = { off: 0, song: 1, track: 1, queue: 2, all: 2 };
        const mode = modes[argument.toLowerCase()];
        if (mode === undefined) return warn('Usage', 'Use `m!repeat off`, `m!repeat song`, or `m!repeat queue`.');
        if (queue.repeatMode !== mode) queue.setRepeatMode(mode);
        return success('Repeat', 'Mode: **' + ['Off', 'Song', 'Queue'][queue.repeatMode] + '**.');
      }

      if (name === 'volume' || name === 'vol') {
        const volume = Number(argument);
        if (!argument || !Number.isInteger(volume) || volume < 0 || volume > 150) {
          return warn('Usage', 'Use `m!volume <0-150>`.');
        }
        queue.setVolume(volume);
        return success('Volume', 'Set to **' + volume + '%**.');
      }
    } catch (error) {
      console.error('[music] command ' + name + ' failed:', error && error.errorCode || '', error && error.message || error);
      return failure(errorMessage(error));
    }
  };
}

function setupMusic(client, providedPlayer) {
  const distube = providedPlayer || new DisTube(client, {
    plugins: [new YouTubePlugin(), new SpotifyPlugin(), new YtDlpPlugin()],
    emitAddSongWhenCreatingQueue: false,
    emitAddListWhenCreatingQueue: false,
    ...(ffmpegPath ? { ffmpeg: { path: ffmpegPath } } : {})
  });

  distube.on('playSong', (queue, song) => {
    broadcast(queue.textChannel, nowEmbed(queue));
  });

  distube.on('addSong', (queue, song) => {
    broadcast(queue.textChannel, card('Added to queue',
      songLabel(song, 155) + '\n**Position:** ' + Math.max(1, queue.songs.length - 1) +
      ' · **Length:** ' + formatDuration(song.duration)));
  });

  distube.on('addList', (queue, list) => {
    broadcast(queue.textChannel, card('Playlist added',
      songLabel(list, 150) + '\n**Tracks:** ' + list.songs.length));
  });

  distube.on('finish', (queue) => {
    broadcast(queue.textChannel, card('Queue finished', 'The queue is empty. Use `m!play` to start again.'));
  });

  distube.on('disconnect', (queue) => {
    console.log('[music] disconnected from guild ' + queue.id);
  });

  distube.on('error', (error, queue) => {
    console.error('[music] playback error:', error && error.errorCode || '', error && error.message || error);
    if (queue) broadcast(queue.textChannel, card('Playback failed', errorMessage(error), COLOR.error));
  });

  client.on(Events.MessageCreate, createMusicHandler(distube));
  return distube;
}

module.exports = {
  setupMusic,
  createMusicHandler,
  parseMusicCommand,
  formatDuration,
  voiceIssue,
  queueEmbed,
  nowEmbed,
  helpEmbed
};
