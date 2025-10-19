const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Discord Music Bot is running!');
});

app.get('/callback', (req, res) => {
  res.send('Spotify callback endpoint');
});

app.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Initialize play-dl for Spotify support
if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  play.setToken({
    spotify: {
      client_id: process.env.SPOTIFY_CLIENT_ID,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      refresh_token: process.env.SPOTIFY_REFRESH_TOKEN,
      market: 'US'
    }
  });
}

// Queue system
const queues = new Map();

class Queue {
  constructor() {
    this.songs = [];
    this.connection = null;
    this.player = null;
    this.isPlaying = false;
  }
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube, Spotify, or search')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('YouTube link, Spotify link, or search term')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playing and clear the queue'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue'),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing song'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),
].map(command => command.toJSON());

// Register slash commands
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();

// Changed from 'ready' to 'clientReady'
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'play') {
      await handlePlay(interaction);
    } else if (commandName === 'skip') {
      await handleSkip(interaction);
    } else if (commandName === 'stop') {
      await handleStop(interaction);
    } else if (commandName === 'queue') {
      await handleQueue(interaction);
    } else if (commandName === 'nowplaying') {
      await handleNowPlaying(interaction);
    } else if (commandName === 'pause') {
      await handlePause(interaction);
    } else if (commandName === 'resume') {
      await handleResume(interaction);
    } else if (commandName === 'help') {
      await handleHelp(interaction);
    }
  } catch (error) {
    console.error('Command error:', error);
    const errorMessage = 'An error occurred while executing this command!';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
    }
  }
});

async function handlePlay(interaction) {
  await interaction.deferReply();

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.editReply('You need to be in a voice channel to play music!');
  }

  const query = interaction.options.getString('query');

  if (!query) {
    return interaction.editReply('Please provide a valid song URL or search term!');
  }

  let songInfo;

  try {
    // Check if it's a Spotify link
    if (query.includes('spotify.com')) {
      songInfo = await handleSpotify(query);
    }
    // Check if it's a YouTube link
    else if (query.includes('youtube.com') || query.includes('youtu.be')) {
      songInfo = await getYouTubeInfo(query);
    }
    // Otherwise, search YouTube
    else {
      songInfo = await searchYouTube(query);
    }

    if (!songInfo || !songInfo.url) {
      return interaction.editReply('Could not find or get song information!');
    }

    const song = {
      title: songInfo.title || 'Unknown Title',
      url: songInfo.url,
      duration: songInfo.duration || 'Unknown',
      thumbnail: songInfo.thumbnail || '',
      requestedBy: interaction.user.tag
    };

    let queue = queues.get(interaction.guild.id);
    if (!queue) {
      queue = new Queue();
      queues.set(interaction.guild.id, queue);

      queue.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });

      queue.player = createAudioPlayer();
      queue.connection.subscribe(queue.player);

      queue.player.on(AudioPlayerStatus.Idle, () => {
        queue.songs.shift();
        if (queue.songs.length > 0) {
          playSong(interaction.guild, queue.songs[0]);
        } else {
          queue.isPlaying = false;
        }
      });

      queue.player.on('error', error => {
        console.error('Audio player error:', error);
        queue.songs.shift();
        if (queue.songs.length > 0) {
          playSong(interaction.guild, queue.songs[0]);
        } else {
          queue.isPlaying = false;
        }
      });
    }

    queue.songs.push(song);

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('Added to Queue')
      .setDescription(`[${song.title}](${song.url})`)
      .addFields({ name: 'Position', value: `${queue.songs.length}`, inline: true })
      .setThumbnail(song.thumbnail)
      .setFooter({ text: `Requested by ${song.requestedBy}` });

    await interaction.editReply({ embeds: [embed] });

    if (!queue.isPlaying) {
      playSong(interaction.guild, song);
    }
  } catch (error) {
    console.error('Play error:', error);
    await interaction.editReply('An error occurred while trying to play the song!');
  }
}

async function handleSpotify(url) {
  try {
    const spotifyData = await play.spotify(url);

    if (spotifyData.type === 'track') {
      // Search for the Spotify track on YouTube
      const searchQuery = `${spotifyData.name} ${spotifyData.artists[0].name}`;
      return await searchYouTube(searchQuery);
    }
  } catch (error) {
    console.error('Spotify error:', error);
    return null;
  }
}

async function searchYouTube(query) {
  try {
    const searchResults = await play.search(query, {
      limit: 1,
      source: { youtube: 'video' }
    });

    if (!searchResults || searchResults.length === 0) {
      console.log('No search results found for:', query);
      return null;
    }

    const video = searchResults[0];

    return {
      title: video.title,
      url: video.url,
      duration: formatDuration(video.durationInSec),
      thumbnail: video.thumbnails[0]?.url || ''
    };
  } catch (error) {
    console.error('YouTube search error:', error);
    return null;
  }
}

async function getYouTubeInfo(url) {
  try {
    const info = await play.video_info(url);
    const video = info.video_details;

    return {
      title: video.title,
      url: video.url,
      duration: formatDuration(video.durationInSec),
      thumbnail: video.thumbnails[0]?.url || ''
    };
  } catch (error) {
    console.error('YouTube info error:', error);
    return null;
  }
}

async function playSong(guild, song) {
  const queue = queues.get(guild.id);

  // Validate inputs
  if (!queue) {
    console.error('Queue not found for guild:', guild.id);
    return;
  }

  if (!song || !song.url) {
    console.error('Invalid song object:', song);
    queue.songs.shift();
    if (queue.songs.length > 0) {
      playSong(guild, queue.songs[0]);
    } else {
      queue.isPlaying = false;
    }
    return;
  }

  try {
    queue.isPlaying = true;

    // Use play-dl to stream audio
    const stream = await play.stream(song.url);

    if (!stream || !stream.stream) {
      throw new Error('Failed to create stream');
    }

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type
    });

    queue.player.play(resource);

    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('Now Playing')
      .setDescription(`[${song.title}](${song.url})`)
      .addFields({ name: 'Duration', value: song.duration, inline: true })
      .setThumbnail(song.thumbnail)
      .setFooter({ text: `Requested by ${song.requestedBy}` });

    const channels = guild.channels.cache;
    const textChannel = channels.find(ch => ch.type === 0 && ch.permissionsFor(guild.members.me).has('SendMessages'));
    if (textChannel) {
      textChannel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('Play song error:', error);
    queue.songs.shift();
    if (queue.songs.length > 0) {
      playSong(guild, queue.songs[0]);
    } else {
      queue.isPlaying = false;
    }
  }
}

async function handleSkip(interaction) {
  const queue = queues.get(interaction.guild.id);
  if (!queue || !queue.isPlaying) {
    return interaction.reply({ content: 'Nothing is playing!', flags: MessageFlags.Ephemeral });
  }

  queue.player.stop();
  await interaction.reply('⏭️ Skipped!');
}

async function handleStop(interaction) {
  const queue = queues.get(interaction.guild.id);
  if (!queue) {
    return interaction.reply({ content: 'Nothing is playing!', flags: MessageFlags.Ephemeral });
  }

  queue.songs = [];
  queue.player.stop();
  queue.connection.destroy();
  queues.delete(interaction.guild.id);
  await interaction.reply('⏹️ Stopped and cleared the queue!');
}

async function handleQueue(interaction) {
  const queue = queues.get(interaction.guild.id);
  if (!queue || queue.songs.length === 0) {
    return interaction.reply({ content: 'The queue is empty!', flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('Music Queue')
    .setDescription(
      queue.songs
        .slice(0, 10)
        .map((song, i) => `${i + 1}. [${song.title}](${song.url}) - ${song.duration}`)
        .join('\n')
    );

  if (queue.songs.length > 10) {
    embed.setFooter({ text: `And ${queue.songs.length - 10} more...` });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleNowPlaying(interaction) {
  const queue = queues.get(interaction.guild.id);
  if (!queue || !queue.isPlaying || queue.songs.length === 0) {
    return interaction.reply({ content: 'Nothing is playing!', flags: MessageFlags.Ephemeral });
  }

  const song = queue.songs[0];
  const embed = new EmbedBuilder()
    .setColor('#00ff00')
    .setTitle('Now Playing')
    .setDescription(`[${song.title}](${song.url})`)
    .addFields({ name: 'Duration', value: song.duration, inline: true })
    .setThumbnail(song.thumbnail)
    .setFooter({ text: `Requested by ${song.requestedBy}` });

  await interaction.reply({ embeds: [embed] });
}

async function handlePause(interaction) {
  const queue = queues.get(interaction.guild.id);
  if (!queue || !queue.isPlaying) {
    return interaction.reply({ content: 'Nothing is playing!', flags: MessageFlags.Ephemeral });
  }

  queue.player.pause();
  await interaction.reply('⏸️ Paused!');
}

async function handleResume(interaction) {
  const queue = queues.get(interaction.guild.id);
  if (!queue) {
    return interaction.reply({ content: 'Nothing is playing!', flags: MessageFlags.Ephemeral });
  }

  queue.player.unpause();
  await interaction.reply('▶️ Resumed!');
}

async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('Music Bot Commands')
    .setDescription('Here are all the available commands:')
    .addFields(
      { name: '/play <query>', value: 'Play a song from YouTube, Spotify, or search term' },
      { name: '/skip', value: 'Skip the current song' },
      { name: '/stop', value: 'Stop playing and clear the queue' },
      { name: '/queue', value: 'Show the current queue' },
      { name: '/nowplaying', value: 'Show the currently playing song' },
      { name: '/pause', value: 'Pause the current song' },
      { name: '/resume', value: 'Resume the paused song' },
      { name: '/help', value: 'Show this help message' }
    );

  await interaction.reply({ embeds: [embed] });
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'Unknown';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

client.login(DISCORD_TOKEN);