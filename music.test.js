const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  setupMusic,
  createMusicHandler,
  parseMusicCommand,
  formatDuration,
  voiceIssue,
  queueEmbed,
  nowEmbed,
  helpEmbed
} = require('./music');

function track(i) {
  return {
    name: 'Song ' + i,
    url: 'https://example.com/song/' + i,
    thumbnail: 'https://example.com/art/' + i + '.png',
    duration: 205,
    source: 'youtube',
    member: { id: '123456789012345678' }
  };
}

function queue(count = 2) {
  return {
    id: 'guild123',
    songs: Array.from({ length: count }, (_, i) => track(i + 1)),
    paused: false,
    currentTime: 28,
    volume: 70,
    repeatMode: 0,
    stop: async function () { this.stopped = true; },
    skip: async function () { this.skipped = true; return this.songs[1]; },
    pause: async function () { this.paused = true; },
    resume: async function () { this.paused = false; },
    shuffle: async function () { this.shuffled = true; },
    setRepeatMode: function (value) { this.repeatMode = value; },
    setVolume: function (value) { this.volume = value; }
  };
}

function message(command, voiceId = 'vc1') {
  const replies = [];
  return {
    content: command,
    guildId: 'guild123',
    guild: { members: { me: { voice: { channelId: 'vc1' } } } },
    member: { voice: { channel: voiceId ? { id: voiceId, name: 'Music VC' } : null } },
    author: { bot: false },
    channel: { isSendable: () => true },
    replies,
    reply: async (payload) => { replies.push(payload); return payload; }
  };
}

function handlerHarness(current = queue()) {
  const state = {
    current,
    requested: [],
    joined: [],
    departed: []
  };
  const player = {
    getQueue: () => state.current,
    play: async (...params) => { state.requested.push(params); },
    voices: {
      join: async (channel) => { state.joined.push(channel.id); },
      leave: (id) => { state.departed.push(id); }
    }
  };
  return { state, handle: createMusicHandler(player) };
}

test('prefix parsing accepts ordinary commands and rejects unrelated messages', () => {
  assert.deepEqual(parseMusicCommand('m!play lonely'), { name: 'play', argument: 'lonely' });
  assert.deepEqual(parseMusicCommand('M!SKIP'), { name: 'skip', argument: '' });
  assert.equal(parseMusicCommand('.play x'), null);
  assert.deepEqual(parseMusicCommand('m!player'), { name: 'player', argument: '' });
  assert.equal(parseMusicCommand('m!'), null);
});

test('durations and queue formatting handle normal and live audio', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(-1), 'LIVE');
  const data = queue(12);
  const embed = queueEmbed(data).toJSON();
  assert.match(embed.description, /Song 11/);
  assert.doesNotMatch(embed.description, /Song 12/);
  assert.match(embed.description, /And \*\*1\*\* more/);
});

test('each feedback embed has no buttons or interactive components', async () => {
  const { handle } = handlerHarness();
  for (const command of ['m!help', 'm!queue', 'm!now', 'm!pause', 'm!resume', 'm!volume 40']) {
    const msg = message(command);
    await handle(msg);
    assert.equal(msg.replies.length, 1);
    assert.equal(msg.replies[0].components, undefined);
    assert.equal(msg.replies[0].embeds.length, 1);
  }
  assert.equal(helpEmbed().toJSON().title, 'Music commands');
  assert.equal(nowEmbed(null).toJSON().title, 'Nothing playing');
});

test('play command passes voice and requested song to the music engine', async () => {
  const { state, handle } = handlerHarness();
  const msg = message('m!play lo-fi study music');
  await handle(msg);
  assert.equal(state.requested.length, 1);
  assert.equal(state.requested[0][0].id, 'vc1');
  assert.equal(state.requested[0][1], 'lo-fi study music');
  assert.equal(state.requested[0][2].textChannel, msg.channel);
});

test('voice channel membership prevents remote playback control', async () => {
  const { state, handle } = handlerHarness();
  assert.equal(voiceIssue(message('m!stop', null).member, message('m!stop').guild, true), 'Join a voice channel first.');
  const msg = message('m!stop', 'vc2');
  await handle(msg);
  assert.equal(state.current.stopped, undefined);
  assert.match(msg.replies[0].embeds[0].toJSON().description, /same voice channel/);
});

test('skip works for a single song without NO_UP_NEXT', async () => {
  const single = queue(1);
  const { handle } = handlerHarness(single);
  const msg = message('m!skip');
  await handle(msg);
  assert.equal(single.stopped, true);
  assert.equal(msg.replies[0].embeds[0].toJSON().title, 'Skipped');
});

test('skip, pause, resume and stop call the queue engine', async () => {
  const q = queue(3);
  const { handle } = handlerHarness(q);
  await handle(message('m!skip'));
  assert.equal(q.skipped, true);
  await handle(message('m!pause'));
  assert.equal(q.paused, true);
  await handle(message('m!resume'));
  assert.equal(q.paused, false);
  await handle(message('m!stop'));
  assert.equal(q.stopped, true);
});

test('repeat, volume and shuffle update the queue', async () => {
  const q = queue(4);
  const { handle } = handlerHarness(q);
  await handle(message('m!repeat queue'));
  assert.equal(q.repeatMode, 2);
  await handle(message('m!volume 45'));
  assert.equal(q.volume, 45);
  await handle(message('m!shuffle'));
  assert.equal(q.shuffled, true);
});

test('joining and leaving the voice channel work without a control panel', async () => {
  const { state, handle } = handlerHarness();
  await handle(message('m!join'));
  assert.deepEqual(state.joined, ['vc1']);
  await handle(message('m!leave'));
  assert.deepEqual(state.departed, ['guild123']);
});

test('setup registers message commands but no interaction buttons', () => {
  const client = new EventEmitter();
  const player = new EventEmitter();
  setupMusic(client, player);
  assert.equal(client.listenerCount('messageCreate'), 1);
  assert.equal(client.listenerCount('interactionCreate'), 0);
});
