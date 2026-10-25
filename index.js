
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  AttachmentBuilder,
  StringSelectMenuBuilder
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ==================================================
// CONFIGURATION
// ==================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "ppg-data.json");

const CAPACITY = 22;
const WAITLIST_CAPACITY = 5;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID environment variable."
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ==================================================
// DATABASE
// ==================================================

function readData() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return parsed && typeof parsed === "object"
      ? parsed
      : { events: {} };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { events: {} };
    }

    throw new Error(
      `Could not read ${DATA_FILE}: ${error.message}`
    );
  }
}

let db = readData();

if (!db.events || typeof db.events !== "object") {
  db = { events: {} };
}

// Upgrade older saved entries without deleting existing records.
for (const event of Object.values(db.events)) {
  event.waves ||= {};

  for (const wave of Object.values(event.waves)) {
    wave.attendees ||= {};
    wave.waitlist ||= [];

    for (const entry of Object.values(wave.attendees)) {
      entry.gameTag ||= "";
      entry.friendTag ||= "";
      entry.friendIgn ||= "";
    }

    for (const entry of wave.waitlist) {
      entry.gameTag ||= "";
      entry.friendTag ||= "";
      entry.friendIgn ||= "";
    }
  }
}

function saveData() {
  const temp = `${DATA_FILE}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(db, null, 2),
    { mode: 0o600 }
  );

  fs.renameSync(temp, DATA_FILE);
}

saveData();

const makeId = () => crypto.randomBytes(4).toString("hex");

const short = (value, max = 80) =>
  String(value ?? "").trim().slice(0, max);

const eventTypes = [
  { name: "200 Sponty", value: "200 Sponty" },
  { name: "400 Gems", value: "400 Gems" },
  { name: "600 Gems", value: "600 Gems" },
  { name: "1K Gems", value: "1K Gems" }
];

function adminOnly(command) {
  return command.setDefaultMemberPermissions(
    PermissionFlagsBits.Administrator
  );
}

// ==================================================
// SLASH COMMANDS
// ==================================================

const commands = [
  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-admin")
      .setDescription("Open the PPG event and wave management panel.")
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-create")
      .setDescription("Create an event and its first wave.")
      .addStringOption(o =>
        o.setName("name")
          .setDescription("Event name")
          .setRequired(true)
          .setMaxLength(80))
      .addStringOption(o =>
        o.setName("type")
          .setDescription("Event type")
          .setRequired(true)
          .addChoices(...eventTypes))
      .addUserOption(o =>
        o.setName("host")
          .setDescription("Event host")
          .setRequired(true))
      .addUserOption(o =>
        o.setName("cohost1")
          .setDescription("First co-host")
          .setRequired(true))
      .addUserOption(o =>
        o.setName("cohost2")
          .setDescription("Second co-host")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("date")
          .setDescription("Optional date and time")
          .setRequired(false)
          .setMaxLength(80))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-wave")
      .setDescription("Create another wave for an event.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("name")
          .setDescription("Wave name")
          .setRequired(true)
          .setMaxLength(40))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-edit")
      .setDescription("Edit an event's details.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("name")
          .setDescription("New event name")
          .setRequired(false)
          .setMaxLength(80))
      .addStringOption(o =>
        o.setName("date")
          .setDescription("New date/time; enter - to clear")
          .setRequired(false)
          .setMaxLength(80))
      .addUserOption(o =>
        o.setName("host")
          .setDescription("New host")
          .setRequired(false))
      .addUserOption(o =>
        o.setName("cohost1")
          .setDescription("New first co-host")
          .setRequired(false))
      .addUserOption(o =>
        o.setName("cohost2")
          .setDescription("New second co-host")
          .setRequired(false))
  ),

  ...["open", "close"].map(action =>
    adminOnly(
      new SlashCommandBuilder()
        .setName(`ppg-${action}`)
        .setDescription(`${action} signups for a wave.`)
        .addStringOption(o =>
          o.setName("event_id")
            .setDescription("Event ID")
            .setRequired(true))
        .addStringOption(o =>
          o.setName("wave_id")
            .setDescription("Wave ID")
            .setRequired(true))
    )
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-end")
      .setDescription("Close all waves for an event.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-delete")
      .setDescription("Permanently delete an event and its data.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("confirm")
          .setDescription("Select DELETE to confirm")
          .setRequired(true)
          .addChoices({ name: "DELETE", value: "DELETE" }))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-add")
      .setDescription("Manually add an attendee.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("wave_id")
          .setDescription("Wave ID")
          .setRequired(true))
      .addUserOption(o =>
        o.setName("member")
          .setDescription("Discord member")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("ign")
          .setDescription("Member's in-game name")
          .setRequired(true)
          .setMaxLength(50))
      .addStringOption(o =>
        o.setName("gametag")
          .setDescription("Member's in-game tag")
          .setRequired(true)
          .setMaxLength(50))
      .addStringOption(o =>
        o.setName("friend_ign")
          .setDescription("Optional friend's IGN")
          .setRequired(false)
          .setMaxLength(50))
      .addStringOption(o =>
        o.setName("friend_tag")
          .setDescription("Optional friend's in-game tag")
          .setRequired(false)
          .setMaxLength(50))
  ),

  ...["remove", "promote"].map(action =>
    adminOnly(
      new SlashCommandBuilder()
        .setName(`ppg-${action}`)
        .setDescription(`${action} an attendee.`)
        .addStringOption(o =>
          o.setName("event_id")
            .setDescription("Event ID")
            .setRequired(true))
        .addStringOption(o =>
          o.setName("wave_id")
            .setDescription("Wave ID")
            .setRequired(true))
        .addUserOption(o =>
          o.setName("member")
            .setDescription("Discord member")
            .setRequired(true))
    )
  ),

  ...["list", "waitlist", "attendance", "export", "panel"].map(action =>
    adminOnly(
      new SlashCommandBuilder()
        .setName(`ppg-${action}`)
        .setDescription(`View or manage ${action}.`)
        .addStringOption(o =>
          o.setName("event_id")
            .setDescription("Event ID")
            .setRequired(true))
        .addStringOption(o =>
          o.setName("wave_id")
            .setDescription("Wave ID")
            .setRequired(true))
    )
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-events")
      .setDescription("List all PPG events.")
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-stats")
      .setDescription("Show overall signup statistics.")
  )
].map(command => command.toJSON());

// ==================================================
// DISCORD CLIENT
// ==================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ==================================================
// EVENT AND WAVE HELPERS
// ==================================================

function getEvent(eventId) {
  return db.events[eventId];
}

function getWave(eventId, waveId) {
  return getEvent(eventId)?.waves?.[waveId];
}

function totalSeats(wave) {
  return Object.values(wave.attendees).reduce(
    (sum, a) => sum + 1 + (a.friendIgn ? 1 : 0),
    0
  );
}

function totalWaitingSeats(wave) {
  return wave.waitlist.reduce(
    (sum, a) => sum + 1 + (a.friendIgn ? 1 : 0),
    0
  );
}

function hostIds(event) {
  return [event.hostId, event.cohost1Id, event.cohost2Id];
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function entryFor(
  userId,
  ign,
  gameTag,
  friendIgn,
  friendTag,
  addedBy
) {
  return {
    userId,
    ign: short(ign, 50),
    gameTag: short(gameTag, 50),
    friendIgn: short(friendIgn, 50),
    friendTag: short(friendTag, 50),
    addedBy,
    signedUpAt: new Date().toISOString()
  };
}

function seatsAvailable(wave, friendIgn) {
  const needed = friendIgn ? 2 : 1;
  return CAPACITY - totalSeats(wave) >= needed;
}

function enqueueOrConfirm(wave, entry) {
  const size = 1 + (entry.friendIgn ? 1 : 0);

  if (
    totalSeats(wave) + size <= CAPACITY &&
    wave.waitlist.length === 0
  ) {
    wave.attendees[entry.userId] = entry;
    return "confirmed";
  }

  if (wave.waitlist.length < WAITLIST_CAPACITY) {
    wave.waitlist.push(entry);
    return "waitlist";
  }

  return "full";
}

function promoteWaiting(wave, userId) {
  const index = wave.waitlist.findIndex(
    a => a.userId === userId
  );

  if (index < 0) return false;

  const entry = wave.waitlist[index];

  if (!seatsAvailable(wave, entry.friendIgn)) {
    return false;
  }

  wave.waitlist.splice(index, 1);
  wave.attendees[userId] = entry;

  return true;
}

function promoteFirstFit(wave) {
  let changed = true;

  while (changed) {
    changed = false;

    const index = wave.waitlist.findIndex(
      a => seatsAvailable(wave, a.friendIgn)
    );

    if (index >= 0) {
      const entry = wave.waitlist.splice(index, 1)[0];
      wave.attendees[entry.userId] = entry;
      changed = true;
    }
  }
}

function getEventWaveOrReply(interaction, eventId, waveId) {
  const event = getEvent(eventId);
  const wave = getWave(eventId, waveId);

  if (!event || !wave) {
    interaction.reply({
      content: "Event or wave not found. Use /ppg-admin to select one.",
      flags: MessageFlags.Ephemeral
    });

    return null;
  }

  return { event, wave };
}

function formatEntry(a, index) {
  let line =
    `**${index + 1}.** <@${a.userId}> — **${a.ign}**` +
    (a.gameTag ? ` | Tag: ${a.gameTag}` : "");

  if (a.friendIgn) {
    line += `\n   ↳ Friend: **${a.friendIgn}**` +
      (a.friendTag ? ` | Tag: ${a.friendTag}` : "");
  }

  return line;
}

// ==================================================
// PUBLIC SIGNUP PANEL
// ==================================================

function panelPayload(eventId, waveId) {
  const event = getEvent(eventId);
  const wave = getWave(eventId, waveId);

  const seats = totalSeats(wave);
  const attendees = Object.values(wave.attendees);

  const embed = new EmbedBuilder()
    .setColor(wave.open && !event.ended ? 0x238636 : 0x8b2635)
    .setTitle(`🎉 ${event.name} — ${wave.name}`)
    .setDescription(
      `**Type:** ${event.type}\n` +
      (event.dateText ? `**When:** ${event.dateText}\n` : "") +
      `**Host:** <@${event.hostId}>\n` +
      `**Co-hosts:** <@${event.cohost1Id}> and <@${event.cohost2Id}>\n\n` +
      `**Attendee places:** ${seats}/${CAPACITY}\n` +
      `**Waiting list:** ${wave.waitlist.length}/${WAITLIST_CAPACITY} signup(s)\n` +
      `**Signups:** ${wave.open && !event.ended ? "🟢 OPEN" : "🔴 CLOSED"}\n\n` +
      "**How to sign up:**\n" +
      "Press **Sign Up** and enter your IGN and in-game Tag. " +
      "Choose YES or NO to add a friend. If YES, enter your friend's IGN and Tag.\n\n" +
      "Each person uses one attendee place."
    )
    .setFooter({
      text: `Event ID: ${eventId} • Wave ID: ${waveId}`
    });

  if (attendees.length) {
    const lines = attendees.map((a, i) => formatEntry(a, i));

    let value = "";

    for (const line of lines) {
      if ((value + "\n" + line).length > 1000) {
        value += "\n…";
        break;
      }

      value += (value ? "\n" : "") + line;
    }

    embed.addFields({
      name: "📋 Confirmed attendees",
      value: value || "No confirmed attendees yet."
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ppg:signup:${eventId}:${waveId}`)
      .setLabel("Sign Up")
      .setEmoji("📝")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!wave.open || event.ended),

    new ButtonBuilder()
      .setCustomId(`ppg:cancel:${eventId}:${waveId}`)
      .setLabel("Cancel Signup")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!wave.open || event.ended)
  );

  return {
    embeds: [embed],
    components: [row]
  };
}

async function refreshPanel(eventId, waveId) {
  const wave = getWave(eventId, waveId);

  if (!wave?.channelId || !wave?.messageId) return;

  try {
    const channel = await client.channels.fetch(wave.channelId);
    if (!channel?.messages) return;

    const message = await channel.messages.fetch(wave.messageId);
    await message.edit(panelPayload(eventId, waveId));
  } catch (error) {
    console.error("Panel refresh failed:", error.message);
  }
}

async function postPanel(interaction, eventId, waveId) {
  if (!interaction.channel?.send) {
    throw new Error("Please use this command in a text channel.");
  }

  const message = await interaction.channel.send(
    panelPayload(eventId, waveId)
  );

  const wave = getWave(eventId, waveId);

  wave.channelId = message.channelId;
  wave.messageId = message.id;

  saveData();

  return message;
}

// ==================================================
// EVENT CREATION HELPERS
// ==================================================

function validHostTeam(host, c1, c2) {
  return new Set([host.id, c1.id, c2.id]).size === 3;
}

function createWave(name, channelId) {
  return {
    id: makeId(),
    name,
    open: true,
    attendees: {},
    waitlist: [],
    channelId,
    messageId: null,
    createdAt: new Date().toISOString()
  };
}

// ==================================================
// ADMIN DROPDOWN MENUS
// ==================================================

function adminEventMenu() {
  const events = Object.values(db.events).slice(-25);

  if (!events.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ppgadmin:event")
      .setPlaceholder("Select an event")
      .addOptions(
        events.map(event => ({
          label: short(event.name, 100),
          description:
            `${event.type}${event.ended ? " • Ended" : ""}`.slice(0, 100),
          value: event.id
        }))
      )
  );
}

function adminWaveMenu(eventId) {
  const event = getEvent(eventId);

  if (!event) return null;

  const waves = Object.values(event.waves || {}).slice(0, 25);

  if (!waves.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ppgadmin:wave:${eventId}`)
      .setPlaceholder("Select a wave")
      .addOptions(
        waves.map(wave => ({
          label: short(wave.name, 100),
          description:
            `${totalSeats(wave)}/${CAPACITY} places • ` +
            `${wave.open ? "Open" : "Closed"}`,
          value: wave.id
        }))
      )
  );
}

function adminActionMenu(eventId, waveId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ppgadmin:action:${eventId}:${waveId}`)
      .setPlaceholder("Choose an admin action")
      .addOptions(
        {
          label: "View attendance",
          value: "attendance",
          description: "Show capacity and signup status"
        },
        {
          label: "View attendee list",
          value: "list",
          description: "Show confirmed attendees"
        },
        {
          label: "View waiting list",
          value: "waitlist",
          description: "Show waiting-list signups"
        },
        {
          label: "Open signups",
          value: "open",
          description: "Allow members to sign up"
        },
        {
          label: "Close signups",
          value: "close",
          description: "Stop new signups"
        },
        {
          label: "Repost signup panel",
          value: "panel",
          description: "Post a fresh signup panel"
        }
      )
  );
}

// ==================================================
// READY EVENT
// ==================================================

client.once("ready", () => {
  console.log(`PPG Signup Bot online as ${client.user.tag}`);
});

// ==================================================
// INTERACTION HANDLER
// ==================================================

client.on("interactionCreate", async interaction => {
  try {

    // ==============================================
    // SLASH COMMANDS
    // ==============================================

    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "Administrator permission is required.",
          flags: MessageFlags.Ephemeral
        });
      }

      // ADMIN PANEL
      if (cmd === "ppg-admin") {
        const row = adminEventMenu();

        if (!row) {
          return interaction.reply({
            content: "No events yet. Create one with /ppg-create.",
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content: "**🏛️ PPG Admin Panel**\nSelect an event below.",
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      }

      // CREATE EVENT
      if (cmd === "ppg-create") {
        const host = interaction.options.getUser("host");
        const c1 = interaction.options.getUser("cohost1");
        const c2 = interaction.options.getUser("cohost2");

        if (!validHostTeam(host, c1, c2)) {
          return interaction.reply({
            content: "Host and co-hosts must be three different people.",
            flags: MessageFlags.Ephemeral
          });
        }

        const eventId = makeId();
        const wave = createWave("Wave 1", interaction.channelId);

        db.events[eventId] = {
          id: eventId,
          name: short(interaction.options.getString("name"), 80),
          type: interaction.options.getString("type"),
          dateText: short(interaction.options.getString("date") || "", 80),
          hostId: host.id,
          cohost1Id: c1.id,
          cohost2Id: c2.id,
          createdBy: interaction.user.id,
          createdAt: new Date().toISOString(),
          ended: false,
          waves: { [wave.id]: wave }
        };

        saveData();

        await interaction.reply({
          content: `Creating **${db.events[eventId].name}**…`,
          flags: MessageFlags.Ephemeral
        });

        await postPanel(interaction, eventId, wave.id);

        return interaction.followUp({
          content:
            `Event created!\nEvent ID: \`${eventId}\`\n` +
            `Wave ID: \`${wave.id}\``,
          flags: MessageFlags.Ephemeral
        });
      }

      // LIST EVENTS
      if (cmd === "ppg-events") {
        const list = Object.values(db.events);

        if (!list.length) {
          return interaction.reply({
            content: "No events have been created yet.",
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content: list.slice(-25).map(e =>
            `**${e.name}** (${e.type}) — \`${e.id}\` — ` +
            `${Object.keys(e.waves || {}).length} wave(s)` +
            (e.ended ? " — ENDED" : "")
          ).join("\n").slice(0, 1900),
          flags: MessageFlags.Ephemeral
        });
      }

      // STATISTICS
      if (cmd === "ppg-stats") {
        const all = Object.values(db.events);
        const waves = all.flatMap(e => Object.values(e.waves || {}));

        return interaction.reply({
          content:
            `**PPG Statistics**\n` +
            `Events: ${all.length}\n` +
            `Waves: ${waves.length}\n` +
            `Confirmed places: ${waves.reduce((n, w) => n + totalSeats(w), 0)}\n` +
            `Waiting-list places: ${waves.reduce((n, w) => n + totalWaitingSeats(w), 0)}`,
          flags: MessageFlags.Ephemeral
        });
      }

      const eventId = interaction.options.getString("event_id");
      const event = eventId ? getEvent(eventId) : null;

      // CREATE WAVE
      if (cmd === "ppg-wave") {
        if (!event) {
          return interaction.reply({
            content: "Event not found. Use /ppg-events to find its ID.",
            flags: MessageFlags.Ephemeral
          });
        }

        const wave = createWave(
          short(interaction.options.getString("name"), 40),
          interaction.channelId
        );

        event.waves[wave.id] = wave;
        saveData();

        await interaction.reply({
          content: `Creating **${wave.name}**…`,
          flags: MessageFlags.Ephemeral
        });

        await postPanel(interaction, eventId, wave.id);

        return interaction.followUp({
          content:
            `Wave created!\nEvent ID: \`${eventId}\`\n` +
            `Wave ID: \`${wave.id}\``,
          flags: MessageFlags.Ephemeral
        });
      }

      // CHECK EVENT FOR EVENT-LEVEL COMMANDS
      if (
        ["ppg-edit", "ppg-end", "ppg-delete"].includes(cmd) &&
        !event
      ) {
        return interaction.reply({
          content: "Event not found. Use /ppg-events to find its ID.",
          flags: MessageFlags.Ephemeral
        });
      }

      // EDIT EVENT
      if (cmd === "ppg-edit") {
        const name = interaction.options.getString("name");
        const date = interaction.options.getString("date");
        const host = interaction.options.getUser("host");
        const c1 = interaction.options.getUser("cohost1");
        const c2 = interaction.options.getUser("cohost2");

        const h = host || { id: event.hostId };
        const a = c1 || { id: event.cohost1Id };
        const b = c2 || { id: event.cohost2Id };

        if (new Set([h.id, a.id, b.id]).size !== 3) {
          return interaction.reply({
            content: "Host and co-hosts must be different people.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (name !== null) event.name = short(name, 80);

        if (date !== null) {
          event.dateText = date === "-" ? "" : short(date, 80);
        }

        event.hostId = h.id;
        event.cohost1Id = a.id;
        event.cohost2Id = b.id;

        saveData();

        for (const wid of Object.keys(event.waves)) {
          await refreshPanel(eventId, wid);
        }

        return interaction.reply({
          content: `Updated **${event.name}**.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // END EVENT
      if (cmd === "ppg-end") {
        event.ended = true;

        for (const wave of Object.values(event.waves)) {
          wave.open = false;
        }

        saveData();

        for (const wid of Object.keys(event.waves)) {
          await refreshPanel(eventId, wid);
        }

        return interaction.reply({
          content: `Ended **${event.name}**. Signup records were preserved.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // DELETE EVENT
      if (cmd === "ppg-delete") {
        for (const wave of Object.values(event.waves)) {
          try {
            if (!wave.channelId || !wave.messageId) continue;

            const channel = await client.channels.fetch(wave.channelId);
            if (!channel?.messages) continue;

            const message = await channel.messages.fetch(wave.messageId);
            await message.delete();
          } catch {}
        }

        delete db.events[eventId];
        saveData();

        return interaction.reply({
          content: `Deleted event \`${eventId}\` and its stored data.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // COMMANDS THAT NEED A WAVE
      const waveId = interaction.options.getString("wave_id");
      const found = getEventWaveOrReply(interaction, eventId, waveId);

      if (!found) return;

      const { event: selectedEvent, wave } = found;

      // OPEN OR CLOSE SIGNUPS
      if (cmd === "ppg-open" || cmd === "ppg-close") {
        if (selectedEvent.ended && cmd === "ppg-open") {
          return interaction.reply({
            content: "This event has ended. Create a new event to reopen signups.",
            flags: MessageFlags.Ephemeral
          });
        }

        wave.open = cmd === "ppg-open";

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Signups are now ${wave.open ? "open" : "closed"}.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // MANUALLY ADD ATTENDEE
      if (cmd === "ppg-add") {
        const member = interaction.options.getUser("member");
        const ign = short(interaction.options.getString("ign"), 50);
        const gameTag = short(interaction.options.getString("gametag"), 50);
        const friendIgn = short(
          interaction.options.getString("friend_ign") || "",
          50
        );
        const friendTag = short(
          interaction.options.getString("friend_tag") || "",
          50
        );

        if (hostIds(selectedEvent).includes(member.id)) {
          return interaction.reply({
            content: "The host team does not use attendee places.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (Boolean(friendIgn) !== Boolean(friendTag)) {
          return interaction.reply({
            content: "Please provide BOTH friend_ign and friend_tag, or leave both blank.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (
          wave.attendees[member.id] ||
          wave.waitlist.some(a => a.userId === member.id)
        ) {
          return interaction.reply({
            content: "That member is already registered.",
            flags: MessageFlags.Ephemeral
          });
        }

        const entry = entryFor(
          member.id,
          ign,
          gameTag,
          friendIgn,
          friendTag,
          interaction.user.id
        );

        const result = enqueueOrConfirm(wave, entry);

        if (result === "full") {
          return interaction.reply({
            content: "The attendee list and waiting list are full.",
            flags: MessageFlags.Ephemeral
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: result === "confirmed"
            ? `Added ${member} to confirmed attendees.`
            : `Added ${member} to the waiting list.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // REMOVE ATTENDEE
      if (cmd === "ppg-remove") {
        const member = interaction.options.getUser("member");

        if (wave.attendees[member.id]) {
          delete wave.attendees[member.id];
          promoteFirstFit(wave);
        } else {
          const index = wave.waitlist.findIndex(
            a => a.userId === member.id
          );

          if (index < 0) {
            return interaction.reply({
              content: "That member is not on this wave's list.",
              flags: MessageFlags.Ephemeral
            });
          }

          wave.waitlist.splice(index, 1);
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Removed ${member} from this wave.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // PROMOTE FROM WAITLIST
      if (cmd === "ppg-promote") {
        const member = interaction.options.getUser("member");

        if (!promoteWaiting(wave, member.id)) {
          return interaction.reply({
            content: "That member is not waiting, or there isn't room for their whole signup.",
            flags: MessageFlags.Ephemeral
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Promoted ${member} to confirmed attendees.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // ATTENDEE LIST OR WAITLIST
      if (cmd === "ppg-list" || cmd === "ppg-waitlist") {
        const entries = cmd === "ppg-waitlist"
          ? wave.waitlist
          : Object.values(wave.attendees);

        if (!entries.length) {
          return interaction.reply({
            content: "No signups in this list.",
            flags: MessageFlags.Ephemeral
          });
        }

        const lines = entries.map((a, i) => formatEntry(a, i));

        return interaction.reply({
          content: lines.join("\n").slice(0, 1900),
          flags: MessageFlags.Ephemeral
        });
      }

      // ATTENDANCE SUMMARY
      if (cmd === "ppg-attendance") {
        return interaction.reply({
          content:
            `**${selectedEvent.name} — ${wave.name}**\n` +
            `Confirmed places: ${totalSeats(wave)}/${CAPACITY}\n` +
            `Waiting-list places: ${totalWaitingSeats(wave)}\n` +
            `Waiting-list signups: ${wave.waitlist.length}/${WAITLIST_CAPACITY}\n` +
            `Status: ${wave.open && !selectedEvent.ended ? "Open" : "Closed"}`,
          flags: MessageFlags.Ephemeral
        });
      }

      // CSV EXPORT
      if (cmd === "ppg-export") {
        const rows = [
          [
            "Discord User ID",
            "IGN",
            "In-Game Tag",
            "Friend IGN",
            "Friend Tag",
            "Status",
            "Signed Up At"
          ]
        ];

        for (const a of Object.values(wave.attendees)) {
          rows.push([
            a.userId,
            a.ign,
            a.gameTag,
            a.friendIgn,
            a.friendTag,
            "Confirmed",
            a.signedUpAt
          ]);
        }

        for (const a of wave.waitlist) {
          rows.push([
            a.userId,
            a.ign,
            a.gameTag,
            a.friendIgn,
            a.friendTag,
            "Waiting list",
            a.signedUpAt
          ]);
        }

        const csv = rows
          .map(row => row.map(csvCell).join(","))
          .join("\n");

        const file = new AttachmentBuilder(
          Buffer.from(csv, "utf8"),
          { name: `ppg-${eventId}-${waveId}.csv` }
        );

        return interaction.reply({
          content: "Attendance export:",
          files: [file],
          flags: MessageFlags.Ephemeral
        });
      }

      // POST A NEW PANEL
      if (cmd === "ppg-panel") {
        await postPanel(interaction, eventId, waveId);

        return interaction.reply({
          content: "Posted a fresh signup panel in this channel.",
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // ==============================================
    // ADMIN DROPDOWN SELECTIONS
    // ==============================================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("ppgadmin:")
    ) {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "Administrator permission is required.",
          flags: MessageFlags.Ephemeral
        });
      }

      const parts = interaction.customId.split(":");
      const stage = parts[1];

      // SELECT EVENT
      if (stage === "event") {
        const eventId = interaction.values[0];
        const event = getEvent(eventId);
        const row = adminWaveMenu(eventId);

        if (!event || !row) {
          return interaction.update({
            content: "Event or waves not found.",
            components: []
          });
        }

        return interaction.update({
          content:
            `**🏛️ PPG Admin Panel**\n` +
            `Event: **${event.name}**\nSelect a wave.`,
          components: [row]
        });
      }

      // SELECT WAVE
      if (stage === "wave") {
        const eventId = parts[2];
        const waveId = interaction.values[0];

        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave) {
          return interaction.update({
            content: "Event or wave not found.",
            components: []
          });
        }

        return interaction.update({
          content:
            `**🏛️ PPG Admin Panel**\n` +
            `Event: **${event.name}**\n` +
            `Wave: **${wave.name}** (${totalSeats(wave)}/${CAPACITY} places)\n` +
            "Choose an action.",
          components: [adminActionMenu(eventId, waveId)]
        });
      }

      // SELECT ADMIN ACTION
      if (stage === "action") {
        const eventId = parts[2];
        const waveId = parts[3];
        const action = interaction.values[0];

        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave) {
          return interaction.update({
            content: "Event or wave not found.",
            components: []
          });
        }

        if (action === "open" || action === "close") {
          if (event.ended && action === "open") {
            return interaction.update({
              content: "This event has ended. Create a new event to reopen signups.",
              components: [adminActionMenu(eventId, waveId)]
            });
          }

          wave.open = action === "open";

          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.update({
            content: `Signups are now **${wave.open ? "OPEN" : "CLOSED"}**.`,
            components: [adminActionMenu(eventId, waveId)]
          });
        }

        if (action === "panel") {
          if (!interaction.channel?.send) {
            return interaction.update({
              content: "Please use the admin panel in a text channel.",
              components: [adminActionMenu(eventId, waveId)]
            });
          }

          const message = await interaction.channel.send(
            panelPayload(eventId, waveId)
          );

          wave.channelId = message.channelId;
          wave.messageId = message.id;

          saveData();

          return interaction.update({
            content: "A fresh signup panel has been posted.",
            components: [adminActionMenu(eventId, waveId)]
          });
        }

        if (action === "attendance") {
          return interaction.update({
            content:
              `**${event.name} — ${wave.name}**\n` +
              `Confirmed places: **${totalSeats(wave)}/${CAPACITY}**\n` +
              `Waiting-list places: **${totalWaitingSeats(wave)}**\n` +
              `Waiting-list signups: **${wave.waitlist.length}/${WAITLIST_CAPACITY}**\n` +
              `Signups: **${wave.open && !event.ended ? "Open" : "Closed"}**\n` +
              `Host: <@${event.hostId}>\n` +
              `Co-hosts: <@${event.cohost1Id}> and <@${event.cohost2Id}>`,
            components: [adminActionMenu(eventId, waveId)]
          });
        }

        const entries = action === "waitlist"
          ? wave.waitlist
          : Object.values(wave.attendees);

        if (!entries.length) {
          return interaction.update({
            content: action === "waitlist"
              ? "The waiting list is empty."
              : "No confirmed attendees yet.",
            components: [adminActionMenu(eventId, waveId)]
          });
        }

        const lines = entries.map((a, i) => formatEntry(a, i));

        return interaction.update({
          content:
            `**${action === "waitlist" ? "Waiting List" : "Confirmed Attendees"}**\n` +
            lines.join("\n").slice(0, 1600),
          components: [adminActionMenu(eventId, waveId)]
        });
      }
    }

    // ==============================================
    // SIGNUP AND CANCEL BUTTONS
    // ==============================================

    if (interaction.isButton()) {
      const parts = interaction.customId.split(":");

      if (parts[0] !== "ppg") return;

      const [, action, eventId, waveId] = parts;

      const event = getEvent(eventId);
      const wave = getWave(eventId, waveId);

      if (!event || !wave) {
        return interaction.reply({
          content: "This event is no longer available.",
          flags: MessageFlags.Ephemeral
        });
      }

      // CANCEL SIGNUP
      if (action === "cancel") {
        if (wave.attendees[interaction.user.id]) {
          delete wave.attendees[interaction.user.id];

          promoteFirstFit(wave);
          saveData();

          await refreshPanel(eventId, waveId);

          return interaction.reply({
            content: "Your signup has been cancelled.",
            flags: MessageFlags.Ephemeral
          });
        }

        const index = wave.waitlist.findIndex(
          a => a.userId === interaction.user.id
        );

        if (index >= 0) {
          wave.waitlist.splice(index, 1);

          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.reply({
            content: "Your waiting-list signup has been cancelled.",
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content: "You do not have a signup for this wave.",
          flags: MessageFlags.Ephemeral
        });
      }

      // START SIGNUP FORM
      if (action === "signup") {
        if (!wave.open || event.ended) {
          return interaction.reply({
            content: "Signups are closed.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (hostIds(event).includes(interaction.user.id)) {
          return interaction.reply({
            content: "Host team members do not use attendee places.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (
          wave.attendees[interaction.user.id] ||
          wave.waitlist.some(a => a.userId === interaction.user.id)
        ) {
          return interaction.reply({
            content: "You're already registered for this wave.",
            flags: MessageFlags.Ephemeral
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`ppgform:${eventId}:${waveId}`)
          .setTitle("PPG Party Signup");

        const ign = new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("1. Your in-game name (IGN)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50)
          .setPlaceholder("Enter your IGN");

        const gameTag = new TextInputBuilder()
          .setCustomId("gametag")
          .setLabel("2. Your in-game Tag")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50)
          .setPlaceholder("Enter your tag");

        const friendChoice = new TextInputBuilder()
          .setCustomId("friend")
          .setLabel("3. Add a friend? Enter YES or NO")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setPlaceholder("YES or NO");

        const friendIgn = new TextInputBuilder()
          .setCustomId("friendign")
          .setLabel("4. Friend's IGN (if YES)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(50)
          .setPlaceholder("Leave blank if NO");

        const friendTag = new TextInputBuilder()
          .setCustomId("friendtag")
          .setLabel("5. Friend's in-game Tag (if YES)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(50)
          .setPlaceholder("Leave blank if NO");

        modal.addComponents(
          new ActionRowBuilder().addComponents(ign),
          new ActionRowBuilder().addComponents(gameTag),
          new ActionRowBuilder().addComponents(friendChoice),
          new ActionRowBuilder().addComponents(friendIgn),
          new ActionRowBuilder().addComponents(friendTag)
        );

        return interaction.showModal(modal);
      }
    }

    // ==============================================
    // SIGNUP FORM SUBMISSION
    // ==============================================

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("ppgform:")
    ) {
      const [, eventId, waveId] = interaction.customId.split(":");

      const event = getEvent(eventId);
      const wave = getWave(eventId, waveId);

      if (!event || !wave || !wave.open || event.ended) {
        return interaction.reply({
          content: "Signups are closed.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (hostIds(event).includes(interaction.user.id)) {
        return interaction.reply({
          content: "Host team members do not use attendee places.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (
        wave.attendees[interaction.user.id] ||
        wave.waitlist.some(a => a.userId === interaction.user.id)
      ) {
        return interaction.reply({
          content: "You're already registered for this wave.",
          flags: MessageFlags.Ephemeral
        });
      }

      const ign = short(
        interaction.fields.getTextInputValue("ign"),
        50
      );

      const gameTag = short(
        interaction.fields.getTextInputValue("gametag"),
        50
      );

      const choice = short(
        interaction.fields.getTextInputValue("friend"),
        3
      ).toLowerCase();

      const friendIgn = short(
        interaction.fields.getTextInputValue("friendign") || "",
        50
      );

      const friendTag = short(
        interaction.fields.getTextInputValue("friendtag") || "",
        50
      );

      const wantsFriend = ["yes", "y"].includes(choice);
      const saysNoFriend = ["no", "n"].includes(choice);

      if (!["yes", "y", "no", "n"].includes(choice)) {
        return interaction.reply({
          content: "For 'Add a friend?', enter YES or NO.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (!ign || !gameTag) {
        return interaction.reply({
          content: "Please enter both your IGN and your in-game Tag.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (wantsFriend && (!friendIgn || !friendTag)) {
        return interaction.reply({
          content: "You chose YES. Please enter BOTH your friend's IGN and Tag, then submit again.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (saysNoFriend && (friendIgn || friendTag)) {
        return interaction.reply({
          content: "You chose NO, so leave both friend fields blank and submit again.",
          flags: MessageFlags.Ephemeral
        });
      }

      const entry = entryFor(
        interaction.user.id,
        ign,
        gameTag,
        wantsFriend ? friendIgn : "",
        wantsFriend ? friendTag : "",
        interaction.user.id
      );

      const result = enqueueOrConfirm(wave, entry);

      if (result === "full") {
        return interaction.reply({
          content: "The attendee list and waiting list are full.",
          flags: MessageFlags.Ephemeral
        });
      }

      saveData();
      await refreshPanel(eventId, waveId);

      const statusText = result === "confirmed"
        ? "You're confirmed"
        : "You've been added to the waiting list";

      return interaction.reply({
        content:
          `${statusText} for **${event.name} — ${wave.name}**.\n` +
          `**IGN:** ${ign}\n` +
          `**Tag:** ${gameTag}` +
          (wantsFriend
            ? `\n**Friend:** ${friendIgn}\n**Friend's Tag:** ${friendTag}`
            : "\n**Friend:** No"),
        flags: MessageFlags.Ephemeral
      });
    }

  } catch (error) {
    console.error("Interaction failed:", error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: "Something went wrong. Please try again or contact an administrator.",
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

// ==================================================
// START BOT AND REGISTER SLASH COMMANDS
// ==================================================

async function start() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("PPG slash commands registered.");

  await client.login(TOKEN);
}

start().catch(error => {
  console.error("Bot startup failed:", error);
  process.exit(1);
});
